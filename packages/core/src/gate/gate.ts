import type {
  AssetLevel,
  GateVerdict,
  ProjectionLevel,
  ToolDefinition,
  ToolResult,
  Redaction,
  Violation,
} from "../types"
import type { AssetMap } from "../asset/policy"
import type { ProjectionEngine } from "../projection/engine"
import type { Guard, GuardInput } from "../guard/guard"
import type { AuditLogger } from "../audit/logger"
import type { Patcher } from "../hightrust/patcher"
import { InfoBudgetTracker } from "./budget"
import { hasPromptInjection, hasIntentInjection } from "../guard/injection"

export type GateConfig = {
  assetMap: AssetMap
  projectionEngine: ProjectionEngine
  guard: Guard
  auditLogger: AuditLogger
  sessionId: string
  patcher?: Patcher
  /** PROXY_WRITE 执行前调用，返回 false 则拒绝写入 */
  approvalCallback?: (filePath: string, intent: string) => Promise<boolean>
  /** 实时事件回调 */
  onEvent?: (event: Record<string, unknown>) => void
  /** 原子写入模式：缓冲 PROXY_WRITE，等待批量审批后执行 */
  atomicWrites?: boolean
}

type PendingWrite = { filePath: string; intent: string }

export class TrustGate {
  private assetMap: AssetMap
  private projectionEngine: ProjectionEngine
  private guard: Guard
  private auditLogger: AuditLogger
  private sessionId: string
  private budget: InfoBudgetTracker
  private patcher?: Patcher
  private approvalCallback?: (filePath: string, intent: string) => Promise<boolean>
  private onEvent?: (event: Record<string, unknown>) => void
  private atomicWrites: boolean
  private pendingWrites: PendingWrite[] = []

  constructor(config: GateConfig) {
    this.assetMap = config.assetMap
    this.projectionEngine = config.projectionEngine
    this.guard = config.guard
    this.auditLogger = config.auditLogger
    this.sessionId = config.sessionId
    this.budget = new InfoBudgetTracker(config.assetMap.getSettings())
    this.patcher = config.patcher
    this.approvalCallback = config.approvalCallback
    this.onEvent = config.onEvent
    this.atomicWrites = config.atomicWrites ?? false
  }

  async evaluate(toolName: string, toolArgs: Record<string, unknown>): Promise<GateVerdict> {
    const start = Date.now()

    let verdict: GateVerdict
    try {
      verdict = await this.doEvaluate(toolName, toolArgs)
    } catch {
      // fail-closed: 异常时拒绝
      verdict = { action: "DENY", reason: "Trust Gate internal error" }
    }

    const durationMs = Date.now() - start
    const filePath = extractFilePath(toolArgs)
    this.auditLogger.logGate(
      this.sessionId,
      toolName,
      verdict.action,
      filePath,
      "reason" in verdict ? verdict.reason : undefined,
      durationMs,
    )

    // 触发实时事件
    this.onEvent?.({
      type: "gate",
      verdict: verdict.action,
      toolName,
      filePath,
      reason: "reason" in verdict ? verdict.reason : undefined,
      durationMs,
    })

    return verdict
  }

  private async doEvaluate(toolName: string, toolArgs: Record<string, unknown>): Promise<GateVerdict> {
    switch (toolName) {
      case "read":
      case "read_file_range":
        return this.evaluateRead(toolArgs.path as string)
      case "edit":
      case "write":
        return this.evaluateWrite(toolArgs.path as string, toolArgs)
      case "grep":
        return this.evaluateGrep()
      case "glob":
        return { action: "PASS" }
      case "bash":
        return { action: "PASS" }
      case "ask_high_trust":
        return this.evaluateAskHighTrust(toolArgs)
      default:
        return { action: "PASS" }
    }
  }

  private evaluateRead(filePath: string): GateVerdict {
    const level = this.assetMap.getLevel(filePath)

    if (level === "public") {
      return { action: "PASS" }
    }

    if (!this.budget.canProject(filePath)) {
      return {
        action: "DENY",
        reason: `信息预算已耗尽: ${filePath}。建议使用 ask_high_trust 获取所需信息。`,
      }
    }

    // 最小披露原则：大文件（>200行）首次读取时降级到 L1
    // 避免直接对大型 secret 文件进行高成本 L2/L3 模型投影
    let projLevel = this.budget.currentLevel(filePath)
    if (projLevel >= 2) {
      try {
        const { readFileSync } = require("fs") as typeof import("fs")
        const source = readFileSync(filePath, "utf-8")
        const lineCount = source.split("\n").length

        // 大文件：首次读取（totalTokens == 0）时降级到 L1
        const budgetEntry = this.budget.getBudgetForFile(filePath)
        if (lineCount > 200 && budgetEntry.tokens === 0) {
          projLevel = 1
          this.onEvent?.({
            type: "gate",
            verdict: "WARN",
            toolName: "read",
            filePath,
            reason: `大文件（${lineCount} 行），首次读取降级到 L1（最小披露原则）`,
            durationMs: 0,
          })
        }

        // Prompt Injection 检测：secret 文件内容可能包含注入指令
        // 若检测到，强制降级到 L1（不经过本地模型）
        if (projLevel >= 2 && hasPromptInjection(source)) {
          projLevel = 1
          this.onEvent?.({
            type: "gate",
            verdict: "WARN",
            toolName: "read",
            filePath,
            reason: "Prompt Injection 检测到，投影降级到 L1",
            durationMs: 0,
          })
        }
      } catch { /* 文件读取失败时不影响主流程 */ }
    }

    return {
      action: "PROXY_READ",
      file: filePath,
      level: projLevel,
    }
  }

  private evaluateWrite(filePath: string, toolArgs: Record<string, unknown>): GateVerdict {
    const level = this.assetMap.getLevel(filePath)

    if (level === "public") {
      return { action: "PASS" }
    }

    const intent = extractIntent(toolArgs)

    // Confused Deputy 防护：检测 intent 中的注入模式
    if (hasIntentInjection(intent)) {
      return {
        action: "DENY",
        reason: `PROXY_WRITE intent 包含疑似注入指令，已拒绝修改 ${filePath}`,
      }
    }

    return {
      action: "PROXY_WRITE",
      file: filePath,
      intent,
    }
  }

  private evaluateGrep(): GateVerdict {
    // grep 先执行再裁剪结果
    return {
      action: "REDACT",
      redactions: [],
    }
  }

  private evaluateAskHighTrust(toolArgs: Record<string, unknown>): GateVerdict {
    if (!this.budget.canAsk()) {
      return {
        action: "DENY",
        reason: `ask_high_trust 次数已达上限。`,
      }
    }

    const files = toolArgs.files as string[] | undefined
    if (files) {
      for (const f of files) {
        this.budget.recordAsk(f)
      }
    }

    return { action: "PASS" }
  }

  /**
   * 执行 PROXY_READ: 返回投影内容而非原文
   */
  async proxyRead(filePath: string, level: ProjectionLevel): Promise<ToolResult> {
    const result = await this.projectionEngine.project({ filePath, level })

    // L0/L1 由我们的确定性代码生成（stat + regex），内容可控，无需 guard
    // L2/L3 由模型生成，必须经过 guard 检查
    const needsGuard = result.generatedBy === "model"
    let guardResult: { passed: boolean; violations: Violation[]; checkedAt: string; durationMs: number } = { passed: true, violations: [], checkedAt: new Date().toISOString(), durationMs: 0 }

    if (needsGuard) {
      try {
        const sourceFiles = this.assetMap.getLevel(filePath) === "secret" ? [filePath] : []
        guardResult = await this.guard.check({
          content: result.content,
          sourceFiles,
          contentType: "projection",
        })
      } catch {
        // Guard 异常时 fail-open，不阻断投影流程
        guardResult = { passed: true, violations: [], checkedAt: new Date().toISOString(), durationMs: 0 }
      }
    }

    this.auditLogger.logProjection(
      this.sessionId,
      filePath,
      level,
      result.tokenCount,
      result.generatedBy,
      guardResult.passed,
    )

    // 无论是否通过 guard，都先记录 budget（防止无限重试消耗）
    this.budget.recordProjection(filePath, level, result.tokenCount)

    // 触发投影事件（含信息预算状态）
    const fileBudget = this.budget.getBudgetForFile(filePath)
    this.onEvent?.({
      type: "projection",
      filePath,
      level,
      tokenCount: result.tokenCount,
      source: result.generatedBy,
      guardPassed: guardResult.passed,
      budgetTokens: fileBudget.tokens,
      budgetCeiling: fileBudget.ceiling,
    })

    if (!guardResult.passed) {
      // 降级到更低级别重试
      if (level > 0) {
        return this.proxyRead(filePath, (level - 1) as ProjectionLevel)
      }
      return {
        output: `[GUARD BLOCKED] 无法安全投影文件 ${filePath}。请使用 ask_high_trust 获取所需信息。`,
      }
    }

    return { output: result.content }
  }

  /**
   * 执行 PROXY_WRITE: 通过 Patcher 在安全域中修改 secret 文件
   */
  async proxyWrite(filePath: string, intent: string): Promise<ToolResult> {
    if (!this.patcher) {
      return {
        output: `[PROXY_WRITE] Patcher 未配置。无法修改 secret 文件 ${filePath}。\n请在 .trust-policy.yml 中配置 models.patcher。`,
      }
    }

    // 用户审批
    if (this.approvalCallback) {
      const approved = await this.approvalCallback(filePath, intent)
      if (!approved) {
        return { output: `[DENIED by user] 用户拒绝修改 ${filePath}` }
      }
    }

    const result = await this.patcher.patch({ filePath, intent })

    if (result.success) {
      // 修改成功，失效该文件的 projection cache
      this.projectionEngine.invalidate(filePath)

      return {
        output: `[PROXY_WRITE OK] ${result.diff}\n备份: ${result.backupPath}`,
      }
    }

    return {
      output: `[PROXY_WRITE FAILED] ${result.error || result.diff}`,
    }
  }

  /**
   * 裁剪 grep 结果中的 secret 文件内容
   */
  redactOutput(result: ToolResult, _toolArgs: Record<string, unknown>): ToolResult {
    const lines = result.output.split("\n")
    const outputLines: string[] = []
    const redactions: Redaction[] = []
    const secretCounts = new Map<string, number>()

    for (const line of lines) {
      const colonIdx = line.indexOf(":")
      if (colonIdx === -1) {
        outputLines.push(line)
        continue
      }

      const filePath = line.slice(0, colonIdx)
      const level = this.assetMap.getLevel(filePath)

      if (level === "public") {
        outputLines.push(line)
      } else {
        secretCounts.set(filePath, (secretCounts.get(filePath) || 0) + 1)
      }
    }

    for (const [file, matches] of secretCounts) {
      outputLines.push(`${file}: [REDACTED - ${matches} match(es) in secret file]`)
      redactions.push({ file, matches })
    }

    return {
      output: outputLines.join("\n"),
      metadata: { redactions },
    }
  }

  /**
   * 包装一个 tool，使其经过 Trust Gate 过滤
   */
  wrapTool(tool: ToolDefinition): ToolDefinition {
    return {
      ...tool,
      execute: async (args) => {
        const verdict = await this.evaluate(tool.name, args)

        switch (verdict.action) {
          case "PASS":
            return tool.execute(args)

          case "PROXY_READ":
            return this.proxyRead(verdict.file, verdict.level)

          case "PROXY_WRITE":
            // 原子写入模式：缓冲写入请求，等待批量执行
            if (this.atomicWrites) {
              this.pendingWrites.push({ filePath: verdict.file, intent: verdict.intent })
              this.onEvent?.({ type: "atomic_write", action: "queued", filePath: verdict.file })
              return { output: `[BUFFERED] ${verdict.file} 写入已缓冲，等待 flush_pending_writes 批量执行。` }
            }
            return this.proxyWrite(verdict.file, verdict.intent)

          case "REDACT": {
            const result = await tool.execute(args)
            return this.redactOutput(result, args)
          }

          case "DENY":
            return { output: `[DENIED] ${verdict.reason}` }
        }
      },
    }
  }

  /**
   * 批量执行所有缓冲的 PROXY_WRITE（原子写入模式）
   */
  async flushPendingWrites(): Promise<{ executed: number; failed: number; results: string[] }> {
    const pending = [...this.pendingWrites]
    this.pendingWrites = []
    if (pending.length === 0) return { executed: 0, failed: 0, results: [] }

    this.onEvent?.({ type: "atomic_write", action: "flushing", count: pending.length })

    let executed = 0
    let failed = 0
    const results: string[] = []

    for (const { filePath, intent } of pending) {
      const result = await this.proxyWrite(filePath, intent)
      if (result.output.startsWith("[PROXY_WRITE OK]")) {
        executed++
      } else {
        failed++
      }
      results.push(`${filePath}: ${result.output.slice(0, 80)}`)
    }

    return { executed, failed, results }
  }

  getPendingWrites(): ReadonlyArray<PendingWrite> {
    return this.pendingWrites
  }

  getBudgetStats() {
    return this.budget.getStats()
  }
}

// ===== 辅助函数 =====

function extractFilePath(toolArgs: Record<string, unknown>): string | undefined {
  return (toolArgs.path || toolArgs.file_path || toolArgs.filePath) as string | undefined
}

function extractIntent(toolArgs: Record<string, unknown>): string {
  if (toolArgs.intent) return toolArgs.intent as string
  if (toolArgs.old_string && toolArgs.new_string) {
    return `修改意图: 将 "${toolArgs.old_string}" 改为 "${toolArgs.new_string}"`
  }
  if (toolArgs.content) {
    return `写入意图: 覆盖文件内容 (${(toolArgs.content as string).length} chars)`
  }
  return "未知修改意图"
}
