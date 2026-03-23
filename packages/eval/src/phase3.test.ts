/**
 * Phase 3 端到端测试
 *
 * 验证：
 * 1. Patcher PROXY_WRITE 流程
 * 2. 双 Workspace 隔离
 * 3. Canary 测试
 * 4. cache 失效和 projection 更新
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { resolve, join } from "path"
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
  lstatSync,
  mkdirSync,
  copyFileSync,
} from "fs"
import {
  loadPolicy,
  createAssetMap,
  Orchestrator,
  WorkspaceManager,
  ProjectionEngine,
  Guard,
  AuditLogger,
  TrustGate,
  CanaryTester,
  type LLMModel,
} from "@trust-proxy/core"

// 用独立的 fixture 副本，避免污染原始 fixture
const ORIGINAL_FIXTURE = resolve(import.meta.dir, "../fixtures/sample-project")
const FIXTURE_ROOT = resolve(import.meta.dir, "../fixtures/phase3-test-project")
const TRUST_DIR = join(FIXTURE_ROOT, ".trust-proxy")

function copyFixture() {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true })
  mkdirSync(FIXTURE_ROOT, { recursive: true })

  // 递归复制
  const copyDir = (src: string, dest: string) => {
    mkdirSync(dest, { recursive: true })
    const { readdirSync, statSync } = require("fs")
    for (const entry of readdirSync(src)) {
      if (entry === ".trust-proxy") continue
      const srcPath = join(src, entry)
      const destPath = join(dest, entry)
      if (statSync(srcPath).isDirectory()) {
        copyDir(srcPath, destPath)
      } else {
        copyFileSync(srcPath, destPath)
      }
    }
  }
  copyDir(ORIGINAL_FIXTURE, FIXTURE_ROOT)
}

beforeAll(() => {
  copyFixture()
})

afterAll(() => {
  if (existsSync(FIXTURE_ROOT)) rmSync(FIXTURE_ROOT, { recursive: true })
})

// ===== 1. 双 Workspace 测试 =====

describe("双 Workspace 隔离", () => {
  test("初始化 public workspace", async () => {
    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const projectionEngine = new ProjectionEngine(FIXTURE_ROOT)

    const wm = new WorkspaceManager(FIXTURE_ROOT, assetMap, projectionEngine)
    const info = await wm.init()

    expect(info.publicCount).toBeGreaterThan(0)
    expect(info.secretCount).toBeGreaterThan(0)
    expect(wm.isInitialized()).toBe(true)
  })

  test("public 文件是 symlink", async () => {
    const publicRoot = join(TRUST_DIR, "workspace")
    const helpersPath = join(publicRoot, "src/utils/helpers.ts")

    expect(existsSync(helpersPath)).toBe(true)

    // 应该是 symlink
    const stat = lstatSync(helpersPath)
    expect(stat.isSymbolicLink()).toBe(true)

    // 内容应和原文一致
    const content = readFileSync(helpersPath, "utf-8")
    expect(content).toContain("export function formatDate")
  })

  test("secret 文件是 projection", async () => {
    const publicRoot = join(TRUST_DIR, "workspace")
    const enginePath = join(publicRoot, "src/core/engine.ts")

    expect(existsSync(enginePath)).toBe(true)

    // 不应该是 symlink
    const stat = lstatSync(enginePath)
    expect(stat.isSymbolicLink()).toBe(false)

    // 内容应是 projection，不是原文
    const content = readFileSync(enginePath, "utf-8")
    expect(content).toContain("[TRUST-PROXY PROJECTION")
    expect(content).not.toContain("sk_live_abc123")
    expect(content).not.toContain("proprietaryScore")
    expect(content).not.toContain("0.7382")
  })

  test("secret 文件的 projection 包含有用信息", async () => {
    const publicRoot = join(TRUST_DIR, "workspace")
    const enginePath = join(publicRoot, "src/core/engine.ts")
    const content = readFileSync(enginePath, "utf-8")

    // 应包含导出的类/函数信息
    expect(content).toContain("SchedulerEngine")
  })

  test("clean 可以删除 workspace", async () => {
    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const projectionEngine = new ProjectionEngine(FIXTURE_ROOT)

    const wm = new WorkspaceManager(FIXTURE_ROOT, assetMap, projectionEngine)
    wm.clean()

    expect(wm.isInitialized()).toBe(false)
  })
})

// ===== 2. PROXY_WRITE 流程测试（无模型，测试拦截和路由） =====

describe("PROXY_WRITE 流程", () => {
  test("无 Patcher 配置时返回提示", async () => {
    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const projectionEngine = new ProjectionEngine(FIXTURE_ROOT)
    const guard = new Guard({})
    const auditLogger = new AuditLogger(FIXTURE_ROOT)

    const gate = new TrustGate({
      assetMap,
      projectionEngine,
      guard,
      auditLogger,
      sessionId: "test-pw",
      // 不传 patcher
    })

    const result = await gate.proxyWrite(
      join(FIXTURE_ROOT, "src/core/engine.ts"),
      "将 maxConcurrency 重命名为 maxParallel",
    )

    expect(result.output).toContain("Patcher 未配置")
  })

  test("secret 文件 edit 经过 wrapTool 被拦截为 PROXY_WRITE", async () => {
    // 使用 scripted model 测试完整流程
    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)

    const { model, receivedMessages } = createScriptedModel([
      // LLM 尝试编辑 secret 文件
      {
        toolCalls: [{
          id: "c1",
          name: "edit",
          args: {
            path: join(FIXTURE_ROOT, "src/core/engine.ts"),
            old_string: "maxConcurrency",
            new_string: "maxParallel",
          },
        }],
        finishReason: "tool_calls",
      },
      { text: "done", finishReason: "stop" },
    ])

    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    const result = await orchestrator.run("重命名变量", 5)

    // tool 返回的消息应包含 PROXY_WRITE 相关内容
    const toolMsgs = result.messages.filter(m => m.role === "tool")
    expect(toolMsgs.length).toBe(1)
    expect(toolMsgs[0].content).toMatch(/PROXY_WRITE|Patcher/)

    // 原文件不应被修改
    const source = readFileSync(join(FIXTURE_ROOT, "src/core/engine.ts"), "utf-8")
    expect(source).toContain("maxConcurrency")
  })
})

// ===== 3. Canary 测试 =====

describe("Canary 测试框架", () => {
  const canaryTester = new CanaryTester()

  afterAll(() => {
    canaryTester.restore()
  })

  test("植入 canary token", () => {
    const token = canaryTester.plant(join(FIXTURE_ROOT, "src/core/engine.ts"))

    expect(token.token).toMatch(/^CANARY_[a-f0-9]{16}$/)
    expect(token.filePath).toContain("engine.ts")

    // 验证文件中包含 canary
    const source = readFileSync(join(FIXTURE_ROOT, "src/core/engine.ts"), "utf-8")
    expect(source).toContain(token.token)
  })

  test("在安全内容中未检测到泄露", () => {
    const results = canaryTester.check(
      "[PROJECTED L1] engine.ts\n\n## Classes\n- export class SchedulerEngine\n\nLines: 44"
    )

    expect(results.length).toBe(1)
    expect(results[0].leaked).toBe(false)
  })

  test("在泄露内容中检测到泄露", () => {
    const tokens = canaryTester.getTokens()
    const leakyContent = `some text ${tokens[0].token} more text`

    const results = canaryTester.check(leakyContent)
    expect(results[0].leaked).toBe(true)
    expect(results[0].foundIn).toContain(tokens[0].token)
  })

  test("完整流程: 植入 → 运行 → 检测 → 恢复", async () => {
    // 植入另一个 canary
    const token2 = canaryTester.plant(join(FIXTURE_ROOT, "src/core/crypto.ts"))

    // 用 scripted model 运行 session，读取 secret 文件
    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)

    const { model, receivedMessages } = createScriptedModel([
      {
        toolCalls: [{
          id: "c1",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/core/engine.ts") },
        }],
        finishReason: "tool_calls",
      },
      {
        toolCalls: [{
          id: "c2",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/core/crypto.ts") },
        }],
        finishReason: "tool_calls",
      },
      { text: "done", finishReason: "stop" },
    ])

    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    await orchestrator.run("分析代码", 10)

    // 检测 canary 是否泄露到发给 LLM 的内容中
    const allContent = receivedMessages.flat().map(m => m.content).join("\n")
    const results = canaryTester.checkAll([allContent])

    // 所有 canary 都不应泄露
    for (const r of results) {
      expect(r.leaked).toBe(false)
    }

    // 生成报告
    const report = canaryTester.report(results)
    expect(report).toContain("所有 canary token 均未泄露")

    // 恢复
    const restoreResult = canaryTester.restore()
    expect(restoreResult.restored).toBe(2)
    expect(restoreResult.failed).toHaveLength(0)

    // 验证文件已恢复
    const source = readFileSync(join(FIXTURE_ROOT, "src/core/engine.ts"), "utf-8")
    expect(source).not.toMatch(/CANARY_/)
  })
})

// ===== 4. Workspace + Orchestrator 集成 =====

describe("Workspace + Orchestrator 集成", () => {
  test("enableWorkspace 模式下 LLM 无法通过 bash 读取 secret 原文", async () => {
    // 先确保 fixture 干净
    if (existsSync(TRUST_DIR)) rmSync(TRUST_DIR, { recursive: true })

    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)

    const { model, receivedMessages } = createScriptedModel([
      // LLM 试图用 bash cat secret 文件
      {
        toolCalls: [{
          id: "c1",
          name: "bash",
          args: { command: `cat src/core/engine.ts` },
        }],
        finishReason: "tool_calls",
      },
      { text: "done", finishReason: "stop" },
    ])

    const orchestrator = new Orchestrator({
      projectRoot: FIXTURE_ROOT,
      assetMap,
      model,
      enableWorkspace: true,
    })
    await orchestrator.run("读取文件", 5)

    // bash cat 在 public workspace 中执行，应该读到 projection 而非原文
    const allContent = receivedMessages.flat().map(m => m.content).join("\n")
    expect(allContent).not.toContain("sk_live_abc123")
    expect(allContent).not.toContain("proprietaryScore")
    expect(allContent).not.toContain("0.7382")

    // 应包含 projection 标记
    expect(allContent).toContain("TRUST-PROXY PROJECTION")
  })
})

// ===== 工具函数 =====

type ScriptStep = {
  text?: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  finishReason: "stop" | "tool_calls"
}

function createScriptedModel(steps: ScriptStep[]) {
  let stepIndex = 0
  const receivedMessages: Array<Array<{ role: string; content: string }>> = []

  const model: LLMModel = {
    async doGenerate(options) {
      receivedMessages.push(JSON.parse(JSON.stringify(options.messages)))
      if (stepIndex >= steps.length) {
        return { text: "done", finishReason: "stop" as const }
      }
      return steps[stepIndex++]
    },
  }

  return { model, receivedMessages }
}
