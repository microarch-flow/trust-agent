import { randomUUID } from "crypto"
import { readFileSync, existsSync } from "fs"
import { join, dirname } from "path"
import type { Session, ToolDefinition, ToolResult, TrustConfig } from "../types"
import type { AssetMap } from "../asset/policy"
import { ProjectionEngine } from "../projection/engine"
import type { ModelProjector } from "../projection/engine"
import { Guard } from "../guard/guard"
import { AuditLogger } from "../audit/logger"
import { TrustGate } from "../gate/gate"
import { HighTrustPool } from "../hightrust/pool"
import { Patcher } from "../hightrust/patcher"
import { WorkspaceManager } from "../workspace/manager"
import { CanaryTester } from "../guard/canary"
import { createBuiltinTools } from "./tools"

export type OrchestratorConfig = {
  projectRoot: string
  /** 新 API：传入完整 TrustConfig（推荐） */
  trustConfig?: TrustConfig
  /** 旧 API：仅传 AssetMap（向后兼容） */
  assetMap?: AssetMap
  /** 是否启用双 workspace 隔离（旧 API，新 API 从 trustConfig.session.workspace.enabled 读取） */
  enableWorkspace?: boolean
  /** Vercel AI SDK model instance */
  model: LLMModel
  /** 额外注册的 tools */
  extraTools?: ToolDefinition[]
  /** PROXY_WRITE 用户审批回调 */
  approvalCallback?: (filePath: string, intent: string) => Promise<boolean>
  /** 实时事件回调（Gate 裁决、投影、LLM token 等） */
  onEvent?: (event: Record<string, unknown>) => void
}

/**
 * 适配 Vercel AI SDK 的 model 接口
 * 实际使用时传入 openai("gpt-4o") 或 anthropic("claude-sonnet-4-20250514") 等
 */
export type LLMModel = {
  doGenerate(options: {
    prompt: string
    tools: LLMToolSpec[]
    messages: LLMMessage[]
    onEvent?: (event: Record<string, unknown>) => void
    onTokenUsage?: (promptTokens: number, completionTokens: number) => void
  }): Promise<LLMResponse>
}

export type LLMToolSpec = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type LLMMessage = {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  toolCallId?: string
  toolName?: string
}

export type LLMToolCall = {
  id: string
  name: string
  args: Record<string, unknown>
}

export type LLMResponse = {
  text?: string
  toolCalls?: LLMToolCall[]
  finishReason: "stop" | "tool_calls" | "length" | "error"
}

export class Orchestrator {
  private config: OrchestratorConfig
  private projectionEngine: ProjectionEngine
  private guard: Guard
  private auditLogger: AuditLogger
  private gate: TrustGate | null = null
  private highTrustPool: HighTrustPool | null = null
  private workspaceManager: WorkspaceManager | null = null
  private tools = new Map<string, ToolDefinition>()
  private session: Session | null = null

  constructor(config: OrchestratorConfig) {
    this.config = config

    // 统一获取 assetMap 和 settings（兼容新旧两种传参方式）
    const assetMap = config.trustConfig?.assetMap ?? config.assetMap!
    const settings = assetMap.getSettings()
    const tc = config.trustConfig

    // 选取 meta-guard 模型
    const metaGuardModel = tc
      ? (tc.models.meta_guard ?? tc.models.answerer ?? tc.models.projector)
      : (settings.high_trust_models?.answerer ?? settings.high_trust_models?.projector)

    // Guard 三层配置
    const guardSec = tc?.security.guard
    this.guard = new Guard({
      publicFiles: [],
      knownSafeTokens: guardSec?.token_match.known_safe_tokens ?? settings.known_safe_tokens,
      structureSimilarityThreshold:
        guardSec?.structure_fingerprint.similarity_threshold ??
        settings.guard?.structure_similarity_threshold ?? 0.75,
      metaGuardEnabled:
        guardSec?.meta_guard.enabled ?? settings.guard?.meta_guard_enabled ?? true,
      metaGuardMaxTokens:
        guardSec?.meta_guard.max_tokens ?? settings.guard?.meta_guard_max_tokens ?? 20,
      metaGuardModel,
    })
    this.auditLogger = new AuditLogger(config.projectRoot)

    // 如果配置了本地 projector 模型，创建 ModelProjector 适配器
    const projectorConfig = tc?.models.projector ?? settings.high_trust_models?.projector
    let modelProjector: ModelProjector | undefined
    if (projectorConfig) {
      const htConfig = tc
        ? { projector: tc.models.projector, answerer: tc.models.answerer, patcher: tc.models.patcher }
        : settings.high_trust_models!
      const poolForProjector = new HighTrustPool(
        htConfig,
        this.guard,
        this.auditLogger,
        "init",
      )
      modelProjector = {
        async project(source: string, filePath: string, level) {
          const result = await poolForProjector.dispatch({
            type: "project",
            file: filePath,
            level,
          })
          if (result.type === "projection") {
            return result.result.content
          }
          return ""
        },
      }
    }

    this.projectionEngine = new ProjectionEngine(config.projectRoot, modelProjector)
  }

  /**
   * 创建新 session 并初始化所有组件
   */
  createSession(taskDescription: string): Session {
    const sessionId = randomUUID().slice(0, 8)

    this.session = {
      id: sessionId,
      taskDescription,
      projectRoot: this.config.projectRoot,
      startedAt: new Date().toISOString(),
      status: "running",
    }

    // 统一获取 assetMap（兼容新旧两种传参方式）
    const assetMapForCreate = this.config.trustConfig?.assetMap ?? this.config.assetMap!

    // 创建 Patcher（如果配置了 patcher 模型）
    const tc2 = this.config.trustConfig
    const patcherConfig = tc2?.models.patcher ?? assetMapForCreate.getSettings().high_trust_models?.patcher
    let patcher: Patcher | undefined
    if (patcherConfig) {
      patcher = new Patcher(
        patcherConfig,
        this.guard,
        this.auditLogger,
        sessionId,
        this.config.projectRoot,
      )
    }

    // 初始化 Trust Gate（含 Patcher）
    const atomicWrites = this.config.trustConfig?.session.atomic_writes ?? false
    this.gate = new TrustGate({
      assetMap: assetMapForCreate,
      projectionEngine: this.projectionEngine,
      guard: this.guard,
      auditLogger: this.auditLogger,
      sessionId,
      patcher,
      approvalCallback: this.config.approvalCallback,
      onEvent: this.config.onEvent,
      atomicWrites,
    })

    // 注册并包装内建 tools
    this.tools.clear()
    const publicRoot = this.workspaceManager?.getPublicRoot()
    const grepExcludeDirs = this.config.trustConfig?.tools.grep.exclude_dirs
    const bashPolicy = this.config.trustConfig?.tools.bash.policy
    const builtins = createBuiltinTools(this.config.projectRoot, publicRoot, {
      grepExcludeDirs,
      bashPolicy,
    })
    for (const tool of builtins) {
      this.tools.set(tool.name, this.gate.wrapTool(tool))
    }

    // 注册额外 tools（同样包装）
    if (this.config.extraTools) {
      for (const tool of this.config.extraTools) {
        this.tools.set(tool.name, this.gate.wrapTool(tool))
      }
    }

    // 创建 HighTrustPool
    const assetMapForSession = this.config.trustConfig?.assetMap ?? this.config.assetMap!
    const tc = this.config.trustConfig
    const htConfig = tc
      ? { projector: tc.models.projector, answerer: tc.models.answerer, patcher: tc.models.patcher, prompts: tc.security.projection.prompts }
      : assetMapForSession.getSettings().high_trust_models
    if (htConfig) {
      this.highTrustPool = new HighTrustPool(
        htConfig,
        this.guard,
        this.auditLogger,
        sessionId,
      )
    }

    // 注册 submit_plan（Planning 分离：LLM 在复杂任务前提交执行计划）
    this.tools.set("submit_plan", {
      name: "submit_plan",
      description: `提交任务执行计划。在开始涉及 3 个或更多文件的复杂任务前，调用此工具列出执行步骤。`,
      parameters: {
        type: "object",
        properties: {
          steps: { type: "array", items: { type: "string" }, description: "执行步骤列表" },
          files_involved: { type: "array", items: { type: "string" }, description: "预计涉及的文件列表" },
        },
        required: ["steps"],
      },
      execute: async (args) => {
        const steps = args.steps as string[]
        const files = (args.files_involved as string[] | undefined) ?? []
        const planText = steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")
        const filesText = files.length > 0 ? `\n  涉及文件: ${files.join(", ")}` : ""
        this.config.onEvent?.({ type: "plan", steps, files_involved: files })
        return { output: `[PLAN SUBMITTED]\n${planText}${filesText}\n计划已提交，现在开始执行。` }
      },
    })

    // 注册 flush_pending_writes（原子写入模式）
    const gateRef = this.gate
    this.tools.set("flush_pending_writes", {
      name: "flush_pending_writes",
      description: "在原子写入模式下，批量执行所有缓冲的文件修改并请求用户审批。完成后报告执行结果。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      execute: async () => {
        const pending = gateRef!.getPendingWrites()
        if (pending.length === 0) {
          return { output: "[FLUSH] 没有待执行的写入操作。" }
        }
        const { executed, failed, results } = await gateRef!.flushPendingWrites()
        const summary = results.join("\n")
        return {
          output: `[FLUSH COMPLETE] 执行 ${executed} 个成功, ${failed} 个失败\n${summary}`,
        }
      },
    })

    // 注册 ask_high_trust
    const pool = this.highTrustPool
    this.tools.set("ask_high_trust", this.gate.wrapTool({
      name: "ask_high_trust",
      description: `向安全域提问关于 secret 文件的具体问题。当你需要了解 secret 文件的内部行为、边界条件或实现细节时使用此工具。回答将是文本描述，不包含源码。`,
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "关于 secret 文件的具体问题" },
          files: { type: "array", items: { type: "string" }, description: "相关的 secret 文件路径" },
          context: { type: "string", description: "为什么需要这个信息" },
        },
        required: ["question", "files"],
      },
      execute: async (args) => {
        if (!pool || !pool.hasAnswerer()) {
          return {
            output: `[ask_high_trust] answerer 模型未配置。请在 .trust-policy.yml 的 settings.high_trust_models.answerer 中配置本地模型端点。`,
          }
        }
        const result = await pool.dispatch({
          type: "answer",
          question: args.question as string,
          files: args.files as string[],
          context: args.context as string | undefined,
        })
        if (result.type === "answer") {
          return { output: result.text }
        }
        return { output: "[ERROR] unexpected result type" }
      },
    }))

    return this.session
  }

  /**
   * 主循环：执行 LLM ↔ Tool 交互直到任务完成
   * @param resumedMessages 从持久化 session 恢复时传入历史消息
   */
  async run(taskDescription: string, maxIterations?: number, resumedMessages?: LLMMessage[]): Promise<RunResult> {
    const resolvedMaxIter =
      maxIterations ??
      this.config.trustConfig?.session.max_iterations ??
      50

    // 初始化双 workspace（如果启用）
    const workspaceEnabled =
      this.config.trustConfig?.session.workspace.enabled ??
      this.config.enableWorkspace ??
      false
    if (workspaceEnabled) {
      this.workspaceManager = new WorkspaceManager(
        this.config.projectRoot,
        this.config.trustConfig?.assetMap ?? this.config.assetMap!,
        this.projectionEngine,
      )
      const wsInfo = await this.workspaceManager.init()
      console.log(`[workspace] 已创建 public workspace: ${wsInfo.publicCount} public, ${wsInfo.secretCount} secret`)
    }

    // ── Canary 自动植入 ────────────────────────────────────────
    const canaryEnabled =
      this.config.trustConfig?.security.guard.canary.auto_plant ?? false
    const canaryTester = new CanaryTester()
    const canaryFiles: string[] = []

    if (canaryEnabled) {
      const assetMapForCanary = this.config.trustConfig!.assetMap
      const secretFiles = assetMapForCanary.listFiles("secret")
      for (const f of secretFiles.slice(0, 3)) { // 最多植入 3 个文件
        try {
          canaryTester.plant(f)
          canaryFiles.push(f)
        } catch { /* 跳过不可写文件 */ }
      }
      if (canaryFiles.length > 0) {
        this.config.onEvent?.({ type: "canary", action: "planted", count: canaryFiles.length })
      }
    }

    const session = this.createSession(taskDescription)
    const onEvent = this.config.onEvent

    // 使用恢复的消息或构建新消息列表
    const systemPrompt = this.buildSystemPrompt(taskDescription)
    const messages: LLMMessage[] = resumedMessages ?? [
      { role: "system", content: systemPrompt },
      { role: "user", content: taskDescription },
    ]

    const toolSpecs = this.getToolSpecs()
    let iterations = 0
    let totalPromptTokens = 0
    let totalCompletionTokens = 0

    while (iterations < resolvedMaxIter) {
      iterations++

      const response = await this.config.model.doGenerate({
        prompt: systemPrompt,
        tools: toolSpecs,
        messages,
        onEvent,
        onTokenUsage: (p, c) => { totalPromptTokens += p; totalCompletionTokens += c },
      })

      // LLM 返回文本
      if (response.text) {
        messages.push({ role: "assistant", content: response.text })
      }

      // 完成
      if (response.finishReason === "stop" || !response.toolCalls?.length) {
        break
      }

      // 执行 tool calls
      if (response.toolCalls) {
        // 记录 assistant 的 tool call 请求
        messages.push({
          role: "assistant",
          content: JSON.stringify(response.toolCalls),
        })

        for (const toolCall of response.toolCalls) {
          const result = await this.executeTool(toolCall.name, toolCall.args)
          messages.push({
            role: "tool",
            content: result.output,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
          })
        }
      }

      if (response.finishReason === "error" || response.finishReason === "length") {
        break
      }
    }

    this.session!.status = iterations >= resolvedMaxIter ? "failed" : "completed"

    // ── Canary 检测与恢复 ──────────────────────────────────────
    let canaryResult: RunResult["canaryResult"]
    if (canaryFiles.length > 0) {
      const allContent = messages.map((m) => String(m.content)).join("\n")
      const results = canaryTester.checkAll([allContent])
      const leaked = results.filter((r) => r.leaked).length
      canaryTester.restore()
      canaryResult = { planted: canaryFiles.length, leaked, safe: leaked === 0 }
      this.config.onEvent?.({ type: "canary", action: "checked", planted: canaryFiles.length, leaked })
    }

    return {
      session,
      messages,
      iterations,
      budgetStats: this.gate!.getBudgetStats(),
      tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens },
      canaryResult,
    }
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { output: `[ERROR] Unknown tool: ${name}` }
    }

    try {
      return await tool.execute(args)
    } catch (err) {
      return { output: `[ERROR] Tool ${name} failed: ${err}` }
    }
  }

  private getToolSpecs(): LLMToolSpec[] {
    const specs: LLMToolSpec[] = []
    for (const tool of this.tools.values()) {
      specs.push({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })
    }
    return specs
  }

  private buildSystemPrompt(taskDescription: string): string {
    const assetMap = this.config.trustConfig?.assetMap ?? this.config.assetMap!
    const settings = assetMap.getSettings()

    // 从外置 prompt 文件加载模板
    const promptsDir = join(dirname(import.meta.url?.replace("file://", "") ?? __filename), "prompts")
    const loadPrompt = (name: string): string => {
      try {
        const p = join(promptsDir, name)
        if (existsSync(p)) return readFileSync(p, "utf-8")
      } catch { /* fall through */ }
      return ""
    }

    const toolGuide = loadPrompt("tool-guide.md")
    const projCtx   = loadPrompt("projection-ctx.md")
    const template  = loadPrompt("system.md")

    // 插值变量
    const interpolate = (s: string) => s
      .replace(/\{\{ask_limit\}\}/g, String(settings.ask_limit))
      .replace(/\{\{info_budget_ceiling\}\}/g, String(settings.info_budget_ceiling))
      .replace(/\{\{task\}\}/g, taskDescription)
      .replace(/\{\{project_root\}\}/g, this.config.projectRoot)
      .replace(/\{\{TOOL_GUIDE\}\}/g, toolGuide)
      .replace(/\{\{PROJECTION_CTX\}\}/g, projCtx)

    if (template) return interpolate(template)

    // フォールバック: 外置ファイルが読めない場合
    return interpolate(`${loadPrompt("system.md") || `你是一个安全编码助手。你在一个信任隔离环境中工作。

## 安全规则
- secret 文件返回投影摘要，不包含原文
- 每个 session 最多 {{ask_limit}} 次 ask_high_trust
- 每个 secret 文件信息预算 {{info_budget_ceiling}} tokens

{{TOOL_GUIDE}}

{{PROJECTION_CTX}}

## 当前任务
{{task}}

## 工作目录
{{project_root}}
`}`)
  }

  getSession(): Session | null {
    return this.session
  }

  getAuditLogPath(): string | undefined {
    if (!this.session) return undefined
    return this.auditLogger.getLogPath(this.session.id)
  }
}

export type RunResult = {
  session: Session
  messages: LLMMessage[]
  iterations: number
  budgetStats: { totalTokens: number; totalAsks: number; trackedFiles: number }
  tokenUsage: { promptTokens: number; completionTokens: number }
  canaryResult?: { planted: number; leaked: number; safe: boolean }
}
