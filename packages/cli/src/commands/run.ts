import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { join, resolve } from "path"
import * as readline from "readline"
import {
  loadTrustConfig,
  Orchestrator,
  type LLMModel,
  type LLMMessage,
  type LowTrustModelConfig,
} from "@trust-proxy/core"
import { CliReporter, type Lang } from "../reporter"

const POLICY_FILE = ".trust-policy.yml"
// 上下文压缩阈值：消息总字符超过此值时截断早期轮次
const CONTEXT_CHAR_LIMIT = 80_000

export async function runAgent(args: string[]) {
  const parsed = parseArgs(args)

  if (!parsed.task && !parsed.resume) {
    console.error("❌ 请提供任务描述")
    console.error('   用法: trust-agent run "任务描述"')
    process.exit(1)
  }

  const projectRoot = resolve(parsed.projectRoot || process.cwd())
  const policyPath = join(projectRoot, POLICY_FILE)

  if (!existsSync(policyPath)) {
    console.error(`❌ 未找到 ${POLICY_FILE}`)
    console.error("   请先运行: trust-agent init")
    process.exit(1)
  }

  const trustConfig = loadTrustConfig(policyPath, projectRoot)
  const modelConfig = resolveModelConfig(trustConfig.models.driver, parsed)

  // ── Session 恢复 ──────────────────────────────────────────
  let resumedMessages: LLMMessage[] | undefined
  let resumedTask: string | undefined
  if (parsed.resume) {
    const sessFile = join(projectRoot, ".trust-proxy", "sessions", `${parsed.resume}.json`)
    if (!existsSync(sessFile)) {
      console.error(`❌ 未找到 session: ${parsed.resume}`)
      process.exit(1)
    }
    const saved = JSON.parse(readFileSync(sessFile, "utf-8"))
    resumedMessages = saved.messages
    resumedTask = saved.task
    console.log(`🔄 恢复 session: ${parsed.resume}`)
    console.log(`   原始任务: ${resumedTask}`)
  }

  const task = parsed.task || resumedTask!

  console.log(`🚀 启动安全编码 session`)
  console.log(`   项目: ${projectRoot}`)
  console.log(`   任务: ${task}`)
  console.log(`   模型: ${modelConfig.provider}/${modelConfig.model}`)
  if (modelConfig.baseURL) console.log(`   端点: ${modelConfig.baseURL}`)
  console.log()

  const model = await createModel(modelConfig)

  const reporter = new CliReporter(parsed.lang)

  // ── PROXY_WRITE 审批回调 ───────────────────────────────────
  const approvalCallback = async (filePath: string, intent: string): Promise<boolean> => {
    console.log()
    console.log(`⚠  [PROXY_WRITE] ${filePath}`)
    console.log(`   意图: ${intent}`)
    const answer = await prompt("   批准写入? [y/n] ")
    return answer.trim().toLowerCase() === "y"
  }

  const orchestrator = new Orchestrator({
    projectRoot,
    trustConfig,
    model,
    approvalCallback,
    onEvent: (event) => reporter.handle(event as Parameters<typeof reporter.handle>[0]),
  })

  const result = await orchestrator.run(task, undefined, resumedMessages)

  // ── 持久化 session ────────────────────────────────────────
  const sessDir = join(projectRoot, ".trust-proxy", "sessions")
  mkdirSync(sessDir, { recursive: true })
  const sessFile = join(sessDir, `${result.session.id}.json`)
  writeFileSync(sessFile, JSON.stringify({ task, messages: result.messages }, null, 2))

  reporter.printSessionSummary({
    sessionId: result.session.id,
    iterations: result.iterations,
    budgetStats: result.budgetStats,
    tokenUsage: result.tokenUsage,
    canaryResult: result.canaryResult,
    auditPath: orchestrator.getAuditLogPath(),
  })

  const lastAssistant = [...result.messages]
    .reverse()
    .find((m) => m.role === "assistant" && typeof m.content === "string" && !m.content.startsWith("["))
  if (lastAssistant) {
    console.log("─".repeat(60))
    console.log(lastAssistant.content)
  }
}


// ── 辅助：stdin readline ───────────────────────────────────────

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

// ── Model 创建 ────────────────────────────────────────────────

function resolveModelConfig(
  fileConfig: LowTrustModelConfig | undefined,
  cliArgs: ParsedArgs,
): LowTrustModelConfig {
  const base: LowTrustModelConfig = fileConfig ?? { provider: "anthropic", model: "claude-sonnet-4-20250514" }
  return {
    provider: cliArgs.provider ?? base.provider,
    model: cliArgs.model ?? base.model,
    apiKey: cliArgs.apiKey ?? base.apiKey,
    baseURL: cliArgs.baseURL ?? base.baseURL,
  }
}

async function createModel(config: LowTrustModelConfig): Promise<LLMModel> {
  switch (config.provider) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      const anthropic = createAnthropic({
        apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      })
      return wrapVercelModel(anthropic(config.model))
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const openai = createOpenAI({
        apiKey: config.apiKey || process.env.OPENAI_API_KEY,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      })
      return wrapVercelModel(openai(config.model))
    }
    case "openai-compatible": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const provider = createOpenAI({
        apiKey: config.apiKey || "no-key",
        baseURL: config.baseURL,
        compatibility: "compatible",
      })
      return wrapVercelModel(provider(config.model))
    }
    default:
      throw new Error(`不支持的 provider: ${config.provider}`)
  }
}

/**
 * 从被压缩的消息中提取关键信息，生成结构化摘要。
 * 替代原来的"早期对话已省略"占位符，提供有用的上下文。
 */
export function buildContextSummary(droppedMessages: any[]): string {
  const filesRead: string[] = []
  const toolCalls: Record<string, number> = {}
  const deniedOps: string[] = []
  const proxyWrites: string[] = []

  for (const msg of droppedMessages) {
    // 从 tool 结果消息中提取信息
    if (msg.role === "tool" && typeof msg.content === "string") {
      const content = msg.content

      if (content.includes("[PROJECTED") || content.includes("[PROJ")) {
        const match = content.match(/\[PROJECTED? L\d\] ([^\n]+)/)
        if (match) filesRead.push(match[1])
      }
      if (content.includes("[DENIED]")) {
        const match = content.match(/\[DENIED\] (.+)/)
        if (match) deniedOps.push(match[1].slice(0, 80))
      }
      if (content.includes("[PROXY_WRITE OK]") || content.includes("[BUFFERED]")) {
        const match = content.match(/\[PROXY_WRITE (?:OK|BUFFERED)\] .* (\S+\.(?:ts|cpp|h|c|py|go|rs|js))/)
        if (match) proxyWrites.push(match[1])
      }
    }
    // 从 assistant tool call 消息中统计调用次数
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "tool-call") {
          toolCalls[part.toolName] = (toolCalls[part.toolName] ?? 0) + 1
        }
      }
    }
  }

  const parts: string[] = ["[上下文已压缩，以下为早期对话摘要]"]
  if (filesRead.length > 0) {
    parts.push(`已读取文件: ${[...new Set(filesRead)].join(", ")}`)
  }
  if (proxyWrites.length > 0) {
    parts.push(`已修改文件: ${[...new Set(proxyWrites)].join(", ")}`)
  }
  if (deniedOps.length > 0) {
    parts.push(`被拒绝操作: ${deniedOps.slice(0, 3).join("; ")}`)
  }
  const callStr = Object.entries(toolCalls).map(([k, v]) => `${k}×${v}`).join(", ")
  if (callStr) parts.push(`工具调用: ${callStr}`)
  parts.push("[继续执行任务]")

  return parts.join("\n")
}

function wrapVercelModel(model: any): LLMModel {
  return {
    async doGenerate(options) {
      const { streamText, jsonSchema } = await import("ai")

      const coreMessages: any[] = []
      for (const m of options.messages) {
        if (m.role === "system") continue
        if (m.role === "user") {
          coreMessages.push({ role: "user", content: m.content })
        } else if (m.role === "assistant") {
          let toolCalls: any[] | null = null
          try {
            const parsed = JSON.parse(m.content as string)
            if (Array.isArray(parsed) && parsed[0]?.name) toolCalls = parsed
          } catch {}

          if (toolCalls) {
            coreMessages.push({
              role: "assistant",
              content: toolCalls.map((tc: any) => ({
                type: "tool-call",
                toolCallId: tc.id,
                toolName: tc.name,
                args: tc.args,
              })),
            })
          } else {
            coreMessages.push({ role: "assistant", content: m.content })
          }
        } else if (m.role === "tool") {
          coreMessages.push({
            role: "tool",
            content: [{
              type: "tool-result",
              toolCallId: m.toolCallId!,
              toolName: m.toolName!,
              result: m.content,
            }],
          })
        }
      }

      // 上下文溢出保护：超限时生成结构化摘要替代截断
      const totalChars = coreMessages.reduce((s, m) => s + JSON.stringify(m).length, 0)
      if (totalChars > CONTEXT_CHAR_LIMIT) {
        const recent = coreMessages.slice(-10)        // 保留最近 10 条
        const dropped = coreMessages.slice(0, -10)   // 被压缩的早期消息
        const summary = buildContextSummary(dropped)
        coreMessages.length = 0
        coreMessages.push({ role: "user", content: summary })
        coreMessages.push(...recent)
      }

      // 发出 llm_start 事件
      options.onEvent?.({ type: "llm_start" })

      const stream = streamText({
        model,
        system: options.prompt,
        messages: coreMessages,
        tools: Object.fromEntries(
          options.tools.map((t: any) => [t.name, {
            description: t.description,
            parameters: jsonSchema(t.parameters as any),
          }])
        ),
        maxSteps: 1,
      })

      // 流式打印 token
      let textOutput = ""
      for await (const chunk of stream.textStream) {
        options.onEvent?.({ type: "llm_token", token: chunk })
        textOutput += chunk
      }
      options.onEvent?.({ type: "llm_end" })

      const finalText = await stream.text
      const toolCalls = await stream.toolCalls
      const finishReason = await stream.finishReason
      const usage = await stream.usage

      // 上报 token 用量
      if (usage && options.onTokenUsage) {
        options.onTokenUsage(usage.promptTokens ?? 0, usage.completionTokens ?? 0)
      }

      return {
        text: finalText || undefined,
        toolCalls: toolCalls?.map((tc: any) => ({
          id: tc.toolCallId || crypto.randomUUID(),
          name: tc.toolName,
          args: tc.args as Record<string, unknown>,
        })),
        finishReason: finishReason === "stop" ? "stop" : "tool_calls",
      }
    },
  }
}

// ── 参数解析 ────────────────────────────────────────────────────

type ParsedArgs = {
  task: string
  resume?: string
  projectRoot?: string
  model?: string
  provider?: "openai" | "anthropic" | "openai-compatible"
  apiKey?: string
  baseURL?: string
  verbose: boolean
  lang: Lang
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { task: "", verbose: false, lang: "en" }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--model" && args[i + 1]) result.model = args[++i]
    else if (arg === "--provider" && args[i + 1]) result.provider = args[++i] as ParsedArgs["provider"]
    else if (arg === "--api-key" && args[i + 1]) result.apiKey = args[++i]
    else if (arg === "--base-url" && args[i + 1]) result.baseURL = args[++i]
    else if (arg === "--project" && args[i + 1]) result.projectRoot = args[++i]
    else if (arg === "--resume" && args[i + 1]) result.resume = args[++i]
    else if (arg === "--lang" && args[i + 1]) result.lang = args[++i] as Lang
    else if (arg === "--verbose" || arg === "-v") result.verbose = true
    else if (!arg.startsWith("-")) result.task = arg
  }

  return result
}
