/**
 * 真实端到端安全验证测试
 *
 * 使用 scripted model 模拟真实 LLM 的多步 tool call 行为，
 * 验证核心安全属性：发送给 cloud LLM 的所有 messages 中
 * 不包含任何 secret 文件的原始内容。
 */
import { describe, test, expect, beforeAll } from "bun:test"
import { resolve, join } from "path"
import { existsSync, readFileSync, rmSync } from "fs"
import {
  loadPolicy,
  createAssetMap,
  Orchestrator,
  type LLMModel,
} from "@trust-proxy/core"
import type { LLMMessage } from "@trust-proxy/core/src/orchestrator/orchestrator"

const FIXTURE_ROOT = resolve(import.meta.dir, "../fixtures/sample-project")
const TRUST_DIR = join(FIXTURE_ROOT, ".trust-proxy")

// 从 secret 文件中提取敏感内容，用于后续安全断言
const SECRET_FILES = [
  join(FIXTURE_ROOT, "src/core/engine.ts"),
  join(FIXTURE_ROOT, "src/core/crypto.ts"),
]

// 这些是 secret 文件中的敏感片段，绝不应出现在发给 LLM 的内容中
const SENSITIVE_TOKENS = [
  "sk_live_abc123_proprietary_key",      // engine.ts 中的密钥
  "secretAlgorithmWeight",               // engine.ts 中的内部变量名
  "0.7382",                              // engine.ts 中的算法权重
  "0.2618",                              // engine.ts 中的算法权重
  "ENCRYPTION_ROUNDS",                   // crypto.ts 中的常量名
  "CUSTOM_SBOX",                         // crypto.ts 中的 S-Box
  "0x63, 0x7c, 0x77",                    // crypto.ts 中的 S-Box 值
  "substituteBytes",                     // crypto.ts 中的内部函数名
  "addRoundKey",                         // crypto.ts 中的内部函数名
  "proprietaryScore",                    // engine.ts 中的内部方法名
]

// 完整的 secret 文件源码行（非 boilerplate，>=24 chars）
const SECRET_SOURCE_LINES: string[] = []
for (const file of SECRET_FILES) {
  const source = readFileSync(file, "utf-8")
  for (const line of source.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length >= 24 && !isBoilerplate(trimmed)) {
      SECRET_SOURCE_LINES.push(trimmed)
    }
  }
}

function isBoilerplate(line: string): boolean {
  return /^(\/\/|\/\*|\*|import |from |export type |type )/.test(line)
}

beforeAll(() => {
  if (existsSync(TRUST_DIR)) {
    rmSync(TRUST_DIR, { recursive: true })
  }
})

/**
 * 创建一个 scripted model，模拟真实 LLM 的多步行为。
 * 记录所有收到的 messages 用于安全审计。
 */
function createScriptedModel(steps: ScriptStep[]): {
  model: LLMModel
  receivedMessages: LLMMessage[][]
} {
  let stepIndex = 0
  const receivedMessages: LLMMessage[][] = []

  const model: LLMModel = {
    async doGenerate(options) {
      // 记录本次收到的所有 messages（这就是发给 cloud LLM 的内容）
      receivedMessages.push(JSON.parse(JSON.stringify(options.messages)))

      if (stepIndex >= steps.length) {
        return { text: "任务完成", finishReason: "stop" as const }
      }

      const step = steps[stepIndex++]
      return step
    },
  }

  return { model, receivedMessages }
}

type ScriptStep = {
  text?: string
  toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>
  finishReason: "stop" | "tool_calls"
}

// ===== 测试场景 =====

describe("安全属性验证：secret 内容不泄露给 cloud LLM", () => {

  test("场景 1: LLM 读取 secret 文件 → 收到 projection，不泄露原文", async () => {
    const { model, receivedMessages } = createScriptedModel([
      // Step 1: LLM 请求读 secret 文件
      {
        toolCalls: [{
          id: "c1",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/core/engine.ts") },
        }],
        finishReason: "tool_calls",
      },
      // Step 2: LLM 读取结果后完成
      {
        text: "engine.ts 是一个调度引擎，包含 SchedulerEngine 类。",
        finishReason: "stop",
      },
    ])

    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    const result = await orchestrator.run("分析 engine.ts 的功能", 10)

    expect(result.session.status).toBe("completed")

    // 核心安全断言：检查所有发给 LLM 的 messages
    assertNoSecretLeakage(receivedMessages)
  })

  test("场景 2: LLM 读取多个文件（混合 secret + public）", async () => {
    const { model, receivedMessages } = createScriptedModel([
      // Step 1: 读 secret 文件
      {
        toolCalls: [{
          id: "c1",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/core/engine.ts") },
        }],
        finishReason: "tool_calls",
      },
      // Step 2: 读 public 文件
      {
        toolCalls: [{
          id: "c2",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/utils/helpers.ts") },
        }],
        finishReason: "tool_calls",
      },
      // Step 3: 读另一个 secret 文件
      {
        toolCalls: [{
          id: "c3",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/core/crypto.ts") },
        }],
        finishReason: "tool_calls",
      },
      // Step 4: 完成
      {
        text: "分析完毕。项目包含调度引擎、加密模块和工具函数。",
        finishReason: "stop",
      },
    ])

    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    const result = await orchestrator.run("分析项目所有模块", 10)

    expect(result.session.status).toBe("completed")
    expect(result.iterations).toBe(4)

    // 安全断言
    assertNoSecretLeakage(receivedMessages)

    // 验证 public 文件原文确实可见
    const allContent = flattenMessages(receivedMessages)
    expect(allContent).toContain("export function formatDate")
    expect(allContent).toContain("export function slugify")
  })

  test("场景 3: LLM 使用 grep 搜索 → secret 文件结果被裁剪", async () => {
    const { model, receivedMessages } = createScriptedModel([
      // Step 1: grep 搜索
      {
        toolCalls: [{
          id: "c1",
          name: "grep",
          args: { pattern: "export", path: FIXTURE_ROOT },
        }],
        finishReason: "tool_calls",
      },
      // Step 2: 完成
      {
        text: "搜索完毕。",
        finishReason: "stop",
      },
    ])

    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    const result = await orchestrator.run("搜索所有 export", 10)

    expect(result.session.status).toBe("completed")

    // 安全断言
    assertNoSecretLeakage(receivedMessages)

    // grep 结果中 secret 文件应显示 REDACTED
    const allContent = flattenMessages(receivedMessages)
    expect(allContent).toContain("REDACTED")
  })

  test("场景 4: LLM 尝试编辑 secret 文件 → 被拦截", async () => {
    const { model, receivedMessages } = createScriptedModel([
      // Step 1: 尝试编辑 secret 文件
      {
        toolCalls: [{
          id: "c1",
          name: "edit",
          args: {
            path: join(FIXTURE_ROOT, "src/core/engine.ts"),
            old_string: "maxConcurrency",
            new_string: "maxParallelism",
          },
        }],
        finishReason: "tool_calls",
      },
      // Step 2: 完成
      {
        text: "修改请求已提交。",
        finishReason: "stop",
      },
    ])

    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    const result = await orchestrator.run("重命名变量", 10)

    expect(result.session.status).toBe("completed")

    // 安全断言
    assertNoSecretLeakage(receivedMessages)

    // 应返回 PROXY_WRITE 提示
    const allContent = flattenMessages(receivedMessages)
    expect(allContent).toContain("PROXY_WRITE")

    // 验证文件未被实际修改
    const source = readFileSync(join(FIXTURE_ROOT, "src/core/engine.ts"), "utf-8")
    expect(source).toContain("maxConcurrency")
    expect(source).not.toContain("maxParallelism")
  })

  test("场景 5: 复杂多步交互 — 读、grep、ask、再读", async () => {
    const { model, receivedMessages } = createScriptedModel([
      // Step 1: glob 查找文件
      {
        toolCalls: [{
          id: "c1",
          name: "bash",
          args: { command: `find ${FIXTURE_ROOT}/src -name "*.ts" -type f` },
        }],
        finishReason: "tool_calls",
      },
      // Step 2: 读 secret 文件
      {
        toolCalls: [{
          id: "c2",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/core/engine.ts") },
        }],
        finishReason: "tool_calls",
      },
      // Step 3: grep 搜索
      {
        toolCalls: [{
          id: "c3",
          name: "grep",
          args: { pattern: "function", path: FIXTURE_ROOT },
        }],
        finishReason: "tool_calls",
      },
      // Step 4: ask_high_trust
      {
        toolCalls: [{
          id: "c4",
          name: "ask_high_trust",
          args: {
            question: "SchedulerEngine 的调度算法时间复杂度是多少？",
            files: [join(FIXTURE_ROOT, "src/core/engine.ts")],
            context: "需要评估性能",
          },
        }],
        finishReason: "tool_calls",
      },
      // Step 5: 读另一个 secret 文件
      {
        toolCalls: [{
          id: "c5",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/core/crypto.ts") },
        }],
        finishReason: "tool_calls",
      },
      // Step 6: 完成
      {
        text: "分析完成。engine.ts 包含调度引擎，crypto.ts 包含加密模块。",
        finishReason: "stop",
      },
    ])

    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    const result = await orchestrator.run("全面分析项目安全架构", 15)

    expect(result.session.status).toBe("completed")
    expect(result.iterations).toBe(6)

    // 核心安全断言
    assertNoSecretLeakage(receivedMessages)

    // 预算统计应该有记录
    expect(result.budgetStats.trackedFiles).toBeGreaterThan(0)
  })
})

describe("投影质量验证", () => {

  test("L1 投影包含足够的结构信息", async () => {
    const { model, receivedMessages } = createScriptedModel([
      {
        toolCalls: [{
          id: "c1",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/core/engine.ts") },
        }],
        finishReason: "tool_calls",
      },
      { text: "done", finishReason: "stop" },
    ])

    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    await orchestrator.run("读取 engine", 5)

    // 找到 tool 返回的 projection 内容
    const toolMsg = receivedMessages
      .flat()
      .find(m => m.role === "tool" && m.content.includes("[PROJECTED"))

    expect(toolMsg).toBeDefined()
    const projection = toolMsg!.content

    // 投影应包含导出的类名
    expect(projection).toContain("SchedulerEngine")
    // 投影应包含某种结构信息
    expect(projection).toMatch(/class|export|function|Exports|Classes/i)
    // 不应包含内部方法名（非 export 的是 IP）
    expect(projection).not.toContain("proprietaryScore")
  })

  test("L1 投影对 crypto.ts 同样有效", async () => {
    const { model, receivedMessages } = createScriptedModel([
      {
        toolCalls: [{
          id: "c1",
          name: "read",
          args: { path: join(FIXTURE_ROOT, "src/core/crypto.ts") },
        }],
        finishReason: "tool_calls",
      },
      { text: "done", finishReason: "stop" },
    ])

    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    await orchestrator.run("读取 crypto", 5)

    const toolMsg = receivedMessages
      .flat()
      .find(m => m.role === "tool" && m.content.includes("[PROJECTED"))

    expect(toolMsg).toBeDefined()
    const projection = toolMsg!.content

    // 应包含导出函数名
    expect(projection).toContain("encryptPayload")
    // 不应包含内部（非 export）函数名
    expect(projection).not.toContain("substituteBytes")
    expect(projection).not.toContain("addRoundKey")
    // 不应包含内部实现细节
    expect(projection).not.toContain("CUSTOM_SBOX")
    expect(projection).not.toContain("0x63")
  })
})

describe("审计日志完整性", () => {

  test("所有 gate 判定都被记录", async () => {
    // 清理
    if (existsSync(TRUST_DIR)) {
      rmSync(TRUST_DIR, { recursive: true })
    }

    const { model } = createScriptedModel([
      {
        toolCalls: [
          { id: "c1", name: "read", args: { path: join(FIXTURE_ROOT, "src/core/engine.ts") } },
        ],
        finishReason: "tool_calls",
      },
      {
        toolCalls: [
          { id: "c2", name: "read", args: { path: join(FIXTURE_ROOT, "src/utils/helpers.ts") } },
        ],
        finishReason: "tool_calls",
      },
      {
        toolCalls: [
          { id: "c3", name: "grep", args: { pattern: "export", path: FIXTURE_ROOT } },
        ],
        finishReason: "tool_calls",
      },
      { text: "done", finishReason: "stop" },
    ])

    const policy = loadPolicy(join(FIXTURE_ROOT, ".trust-policy.yml"))
    const assetMap = createAssetMap(policy, FIXTURE_ROOT)
    const orchestrator = new Orchestrator({ projectRoot: FIXTURE_ROOT, assetMap, model })
    const result = await orchestrator.run("审计测试", 10)

    const auditPath = orchestrator.getAuditLogPath()
    expect(auditPath).toBeDefined()
    expect(existsSync(auditPath!)).toBe(true)

    const lines = readFileSync(auditPath!, "utf-8").trim().split("\n")
    const events = lines.map(l => JSON.parse(l))

    // 应有 3 个 gate 事件
    const gateEvents = events.filter((e: any) => e.type === "gate")
    expect(gateEvents.length).toBe(3)

    // 验证 verdict 类型
    const verdicts = gateEvents.map((e: any) => e.verdict)
    expect(verdicts).toContain("PROXY_READ")  // secret file read
    expect(verdicts).toContain("PASS")        // public file read
    expect(verdicts).toContain("REDACT")      // grep

    // 应有 projection 事件
    const projEvents = events.filter((e: any) => e.type === "projection")
    expect(projEvents.length).toBeGreaterThan(0)
    expect(projEvents[0].guardPassed).toBe(true)
  })
})

// ===== 安全断言工具函数 =====

/**
 * 核心安全断言：检查所有发给 LLM 的 messages 中不包含任何 secret 内容
 */
function assertNoSecretLeakage(allRounds: LLMMessage[][]) {
  const allContent = flattenMessages(allRounds)

  // 检查敏感 token
  for (const token of SENSITIVE_TOKENS) {
    expect(allContent).not.toContain(token)
  }

  // 检查源码行（非 boilerplate 的长行）
  let leakedLines = 0
  for (const line of SECRET_SOURCE_LINES) {
    if (allContent.includes(line)) {
      leakedLines++
      console.error(`[LEAK DETECTED] 源码行泄露: "${line.slice(0, 60)}..."`)
    }
  }
  expect(leakedLines).toBe(0)
}

/**
 * 把所有轮次的 messages 拼成一个大字符串
 */
function flattenMessages(allRounds: LLMMessage[][]): string {
  return allRounds
    .flat()
    .map(m => m.content)
    .join("\n")
}
