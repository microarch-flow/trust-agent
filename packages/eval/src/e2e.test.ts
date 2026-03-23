import { describe, test, expect, beforeAll } from "bun:test"
import { resolve, join } from "path"
import { existsSync, readFileSync, rmSync } from "fs"
import {
  loadPolicy,
  createAssetMap,
  TrustGate,
  ProjectionEngine,
  Guard,
  AuditLogger,
  Orchestrator,
  type LLMModel,
} from "@trust-proxy/core"

const FIXTURE_ROOT = resolve(import.meta.dir, "../fixtures/sample-project")
const TRUST_DIR = join(FIXTURE_ROOT, ".trust-proxy")

// 清理上次运行的缓存/审计
beforeAll(() => {
  if (existsSync(TRUST_DIR)) {
    rmSync(TRUST_DIR, { recursive: true })
  }
})

// ===== 1. Asset Map 测试 =====

describe("Asset Map", () => {
  const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
  const assetMap = createAssetMap(policy, FIXTURE_ROOT)

  test("secret 文件识别正确", () => {
    const level = assetMap.getLevel(join(FIXTURE_ROOT, "src/core/engine.ts"))
    expect(level).toBe("secret")
  })

  test("secret glob 匹配子目录", () => {
    const level = assetMap.getLevel(join(FIXTURE_ROOT, "src/core/crypto.ts"))
    expect(level).toBe("secret")
  })

  test("public 文件识别正确", () => {
    const level = assetMap.getLevel(join(FIXTURE_ROOT, "src/utils/helpers.ts"))
    expect(level).toBe("public")
  })

  test("settings 加载正确", () => {
    const settings = assetMap.getSettings()
    expect(settings.default_projection_level).toBe(1)
    expect(settings.ask_limit).toBe(20)
    expect(settings.info_budget_ceiling).toBe(4096)
  })
})

// ===== 2. Trust Gate 测试 =====

describe("Trust Gate", () => {
  const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
  const assetMap = createAssetMap(policy, FIXTURE_ROOT)
  const projectionEngine = new ProjectionEngine(FIXTURE_ROOT)
  const guard = new Guard({ publicFiles: [], knownSafeTokens: [] })
  const auditLogger = new AuditLogger(FIXTURE_ROOT)

  const gate = new TrustGate({
    assetMap,
    projectionEngine,
    guard,
    auditLogger,
    sessionId: "test-session",
  })

  test("public 文件 read → PASS", async () => {
    const verdict = await gate.evaluate("read", {
      path: join(FIXTURE_ROOT, "src/utils/helpers.ts"),
    })
    expect(verdict.action).toBe("PASS")
  })

  test("secret 文件 read → PROXY_READ", async () => {
    const verdict = await gate.evaluate("read", {
      path: join(FIXTURE_ROOT, "src/core/engine.ts"),
    })
    expect(verdict.action).toBe("PROXY_READ")
    if (verdict.action === "PROXY_READ") {
      expect(verdict.file).toContain("engine.ts")
      expect(verdict.level).toBeGreaterThanOrEqual(0)
    }
  })

  test("secret 文件 edit → PROXY_WRITE", async () => {
    const verdict = await gate.evaluate("edit", {
      path: join(FIXTURE_ROOT, "src/core/engine.ts"),
      old_string: "foo",
      new_string: "bar",
    })
    expect(verdict.action).toBe("PROXY_WRITE")
  })

  test("public 文件 edit → PASS", async () => {
    const verdict = await gate.evaluate("edit", {
      path: join(FIXTURE_ROOT, "src/utils/helpers.ts"),
      old_string: "foo",
      new_string: "bar",
    })
    expect(verdict.action).toBe("PASS")
  })

  test("grep → REDACT", async () => {
    const verdict = await gate.evaluate("grep", {
      pattern: "export",
    })
    expect(verdict.action).toBe("REDACT")
  })

  test("glob → PASS", async () => {
    const verdict = await gate.evaluate("glob", {
      pattern: "**/*.ts",
    })
    expect(verdict.action).toBe("PASS")
  })

  test("bash → PASS", async () => {
    const verdict = await gate.evaluate("bash", {
      command: "ls",
    })
    expect(verdict.action).toBe("PASS")
  })
})

// ===== 3. Projection 测试 =====

describe("Projection", () => {
  const projectionEngine = new ProjectionEngine(FIXTURE_ROOT)

  test("L0 projection 返回文件元信息", async () => {
    const result = await projectionEngine.project({
      filePath: join(FIXTURE_ROOT, "src/core/engine.ts"),
      level: 0,
    })
    expect(result.content).toContain("[PROJECTED L0]")
    expect(result.content).toContain("engine.ts")
    expect(result.content).toContain("lines")
    expect(result.generatedBy).toBe("stat")
    // 不应包含源码
    expect(result.content).not.toContain("INTERNAL_SECRET_KEY")
    expect(result.content).not.toContain("proprietaryScore")
  })

  test("L1 projection 返回签名", async () => {
    const result = await projectionEngine.project({
      filePath: join(FIXTURE_ROOT, "src/core/engine.ts"),
      level: 1,
    })
    expect(result.content).toContain("[PROJECTED L1]")
    expect(result.generatedBy).toBe("treesitter")
    // L1 应包含 class 名但不包含函数体
    expect(result.content).toContain("SchedulerEngine")
    // 不应泄露 secret key
    expect(result.content).not.toContain("sk_live_abc123")
    expect(result.content).not.toContain("0.7382")
  })

  test("无 model 时 L2 降级到 L1", async () => {
    const result = await projectionEngine.project({
      filePath: join(FIXTURE_ROOT, "src/core/engine.ts"),
      level: 2,
    })
    // 没配 modelProjector，应 fallback 到 L1
    expect(result.level).toBe(1)
    expect(result.generatedBy).toBe("treesitter")
  })

  test("cache 命中", async () => {
    const stats1 = projectionEngine.getCacheStats()
    // 再次请求同一文件同一级别
    await projectionEngine.project({
      filePath: join(FIXTURE_ROOT, "src/core/engine.ts"),
      level: 0,
    })
    const stats2 = projectionEngine.getCacheStats()
    expect(stats2.hits).toBeGreaterThan(stats1.hits)
  })
})

// ===== 4. Guard 测试 =====

describe("Guard", () => {
  const guard = new Guard({
    publicFiles: [join(FIXTURE_ROOT, "src/utils/helpers.ts")],
    knownSafeTokens: [],
    minTokenLength: 7,
    minLineLength: 24,
  })

  test("干净的投影通过检查", async () => {
    const result = await guard.check({
      content: "[PROJECTED L0] engine.ts\nFile exists, 42 lines, 1200 bytes",
      sourceFiles: [join(FIXTURE_ROOT, "src/core/engine.ts")],
      contentType: "projection",
    })
    expect(result.passed).toBe(true)
    expect(result.violations).toHaveLength(0)
  })

  test("包含 secret token 的内容不通过", async () => {
    const result = await guard.check({
      content: "The engine uses INTERNAL_SECRET_KEY for authentication and secretAlgorithmWeight for scoring",
      sourceFiles: [join(FIXTURE_ROOT, "src/core/engine.ts")],
      contentType: "projection",
    })
    expect(result.passed).toBe(false)
    expect(result.violations.length).toBeGreaterThan(0)
    expect(result.violations.some(v => v.type === "token_leak")).toBe(true)
  })

  test("包含源码行的内容不通过", async () => {
    // 直接复制一行 engine.ts 中的非 boilerplate 代码
    const result = await guard.check({
      content: 'The function calculates: this.proprietaryScore(b) - this.proprietaryScore(a)',
      sourceFiles: [join(FIXTURE_ROOT, "src/core/engine.ts")],
      contentType: "projection",
    })
    expect(result.passed).toBe(false)
    expect(result.violations.some(v => v.type === "line_leak")).toBe(true)
  })
})

// ===== 5. PROXY_READ 端到端测试 =====

describe("PROXY_READ end-to-end", () => {
  const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
  const assetMap = createAssetMap(policy, FIXTURE_ROOT)
  const projectionEngine = new ProjectionEngine(FIXTURE_ROOT)
  const guard = new Guard({
    publicFiles: [join(FIXTURE_ROOT, "src/utils/helpers.ts")],
    knownSafeTokens: [],
  })
  const auditLogger = new AuditLogger(FIXTURE_ROOT)

  const gate = new TrustGate({
    assetMap,
    projectionEngine,
    guard,
    auditLogger,
    sessionId: "e2e-test",
  })

  test("secret 文件通过 wrapTool 返回 projection 而非原文", async () => {
    const readTool = {
      name: "read",
      description: "read file",
      parameters: {},
      execute: async (args: Record<string, unknown>) => ({
        output: readFileSync(args.path as string, "utf-8"),
      }),
    }

    const wrapped = gate.wrapTool(readTool)
    const result = await wrapped.execute({
      path: join(FIXTURE_ROOT, "src/core/engine.ts"),
    })

    // 应返回 projection
    expect(result.output).toContain("[PROJECTED")
    // 不应泄露 secret
    expect(result.output).not.toContain("sk_live_abc123")
    expect(result.output).not.toContain("proprietaryScore")
    expect(result.output).not.toContain("0.7382")
  })

  test("public 文件通过 wrapTool 返回原文", async () => {
    const readTool = {
      name: "read",
      description: "read file",
      parameters: {},
      execute: async (args: Record<string, unknown>) => ({
        output: readFileSync(args.path as string, "utf-8"),
      }),
    }

    const wrapped = gate.wrapTool(readTool)
    const result = await wrapped.execute({
      path: join(FIXTURE_ROOT, "src/utils/helpers.ts"),
    })

    // 应返回原文
    expect(result.output).toContain("export function formatDate")
    expect(result.output).toContain("export function slugify")
  })

  test("audit log 被正确写入", () => {
    const logPath = auditLogger.getLogPath("e2e-test")
    expect(existsSync(logPath)).toBe(true)

    const content = readFileSync(logPath, "utf-8").trim()
    const events = content.split("\n").map(l => JSON.parse(l))

    // 应有 gate 事件
    const gateEvents = events.filter((e: any) => e.type === "gate")
    expect(gateEvents.length).toBeGreaterThan(0)

    // 应有 projection 事件
    const projEvents = events.filter((e: any) => e.type === "projection")
    expect(projEvents.length).toBeGreaterThan(0)
  })
})

// ===== 6. Orchestrator mock 测试 =====

describe("Orchestrator with mock model", () => {
  test("mock model 驱动完整 session", async () => {
    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)

    let callCount = 0

    // Mock model: 第一轮读 secret 文件，第二轮读 public 文件，第三轮结束
    const mockModel: LLMModel = {
      async doGenerate(options) {
        callCount++

        if (callCount === 1) {
          return {
            toolCalls: [{
              id: "call-1",
              name: "read",
              args: { path: join(FIXTURE_ROOT, "src/core/engine.ts") },
            }],
            finishReason: "tool_calls" as const,
          }
        }

        if (callCount === 2) {
          return {
            toolCalls: [{
              id: "call-2",
              name: "read",
              args: { path: join(FIXTURE_ROOT, "src/utils/helpers.ts") },
            }],
            finishReason: "tool_calls" as const,
          }
        }

        return {
          text: "任务完成。secret 文件 engine.ts 包含 SchedulerEngine 类，public 文件 helpers.ts 包含工具函数。",
          finishReason: "stop" as const,
        }
      },
    }

    const orchestrator = new Orchestrator({
      projectRoot: FIXTURE_ROOT,
      assetMap,
      model: mockModel,
    })

    const result = await orchestrator.run("分析项目结构", 10)

    expect(result.session.status).toBe("completed")
    expect(result.iterations).toBe(3)

    // 验证消息历史中 secret 文件返回了 projection
    const toolMessages = result.messages.filter(m => m.role === "tool")
    expect(toolMessages.length).toBe(2)

    // 第一条 tool 消息（secret 文件）应是 projection
    expect(toolMessages[0].content).toContain("[PROJECTED")
    expect(toolMessages[0].content).not.toContain("sk_live_abc123")

    // 第二条 tool 消息（public 文件）应是原文
    expect(toolMessages[1].content).toContain("export function formatDate")

    // 验证 audit log
    const auditPath = orchestrator.getAuditLogPath()
    expect(auditPath).toBeDefined()
    expect(existsSync(auditPath!)).toBe(true)
  })
})
