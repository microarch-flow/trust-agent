/**
 * CliReporter — Sprint 4 可观测性
 *
 * 统一的终端输出类。处理来自 Orchestrator/Gate 的事件流，
 * 实时展示信任域切换，并在 session 结束后输出结构化摘要。
 *
 * 输出格式示例：
 *   ✓ [PASS]       read src/utils/helpers.ts (12ms)
 *   ⟳ [PROXY_READ] src/core/engine.ts → 投影中...
 *   ✓ [PROJ L2]    src/core/engine.ts 342tok (model) [budget: 342/4096tok]
 *   ✗ [DENY]       信息预算已耗尽: src/engine.ts
 *              → 建议: 使用 ask_high_trust 工具获取所需信息
 */

export type TrustEvent = Record<string, unknown> & { type: string }
export type Lang = "en" | "zh"

// Localised strings used by CliReporter
const STRINGS = {
  en: {
    projecting:      "projecting…",
    proxyWrite:      "pending approval",
    redact:          "grep results filtered",
    budgetBar:       "Information budget:",
    apiUsage:        "API usage:",
    sessionDone:     "Session complete:",
    iterations:      "Iterations:",
    toolStats:       "Tool call summary",
    projStats:       "Projection summary",
    guardBlocked:    "Guard blocked",
    askCount:        "ask_high_trust calls:",
    auditLog:        "Audit log:",
    resumeCmd:       "Resume with:",
    canaryOk:        "tokens safe",
    canaryLeak:      "tokens leaked!",
    planHeader:      "Execution plan",
    planFiles:       "Files:",
    buffered:        "write buffered (awaiting flush)",
    atomicFlush:     "Batch write",
    awaitingApproval:"files awaiting approval…",
    denySugPrefix:   "Suggestion:",
  },
  zh: {
    projecting:      "投影中…",
    proxyWrite:      "等待审批",
    redact:          "grep 结果已过滤",
    budgetBar:       "信息预算:",
    apiUsage:        "API 用量:",
    sessionDone:     "Session 完成:",
    iterations:      "迭代次数:",
    toolStats:       "工具调用统计",
    projStats:       "投影统计",
    guardBlocked:    "Guard 拦截",
    askCount:        "ask_high_trust 次:",
    auditLog:        "审计日志:",
    resumeCmd:       "恢复命令:",
    canaryOk:        "个 token 全部安全",
    canaryLeak:      "个 token 泄露！",
    planHeader:      "执行计划",
    planFiles:       "涉及:",
    buffered:        "写入已缓冲（等待批量审批）",
    atomicFlush:     "批量写入",
    awaitingApproval:"个文件，等待审批…",
    denySugPrefix:   "建议:",
  },
} as const

type Stats = {
  pass: number
  proxyRead: number
  proxyWrite: number
  deny: number
  redact: number
  warn: number
  projByLevel: number[]   // index = level 0..3
  guardBlocked: number
}

type FileBudget = { tokens: number; ceiling: number }

export class CliReporter {
  private stats: Stats = {
    pass: 0,
    proxyRead: 0,
    proxyWrite: 0,
    deny: 0,
    redact: 0,
    warn: 0,
    projByLevel: [0, 0, 0, 0],
    guardBlocked: 0,
  }
  private fileBudget = new Map<string, FileBudget>()
  private t: typeof STRINGS["en"]

  constructor(lang: Lang = "en") {
    this.t = STRINGS[lang]
  }

  /** 处理一个来自 Orchestrator / Gate 的事件 */
  handle(event: TrustEvent): void {
    switch (event.type) {
      case "gate":       this.handleGate(event);       break
      case "projection": this.handleProjection(event); break
      case "llm_start":  process.stdout.write("  ⟳ [LLM]        "); break
      case "llm_token":  process.stdout.write(event.token as string); break
      case "llm_end":    process.stdout.write("\n");   break
      case "canary":     this.handleCanary(event);     break
      case "plan":       this.handlePlan(event);       break
      case "atomic_write": this.handleAtomicWrite(event); break
    }
  }

  private handleGate(event: TrustEvent): void {
    const verdict   = event.verdict   as string
    const toolName  = event.toolName  as string
    const filePath  = event.filePath  as string | undefined
    const reason    = event.reason    as string | undefined
    const durationMs = event.durationMs as number | undefined

    const ms = durationMs != null && durationMs > 0 ? ` (${durationMs}ms)` : ""
    const fp = filePath ? ` ${filePath}` : ""

    switch (verdict) {
      case "PASS":
        this.stats.pass++
        process.stdout.write(`  ✓ [PASS]       ${toolName}${fp}${ms}\n`)
        break
      case "PROXY_READ":
        this.stats.proxyRead++
        process.stdout.write(`  ⟳ [PROXY_READ] ${filePath} → ${this.t.projecting}\n`)
        break
      case "PROXY_WRITE":
        this.stats.proxyWrite++
        process.stdout.write(`  ⚠  [PROXY_WRITE] ${filePath} (${this.t.proxyWrite})\n`)
        break
      case "REDACT":
        this.stats.redact++
        process.stdout.write(`  ✓ [REDACT]     ${this.t.redact}\n`)
        break
      case "DENY": {
        this.stats.deny++
        process.stdout.write(`  ✗ [DENY]       ${reason ?? ""}`)
        const suggestion = getDenySuggestion(reason, this.t.denySugPrefix)
        if (suggestion) process.stdout.write(`\n             → ${suggestion}`)
        process.stdout.write("\n")
        break
      }
      case "WARN":
        this.stats.warn++
        process.stdout.write(`  ⚠  [WARN]       ${reason ?? ""}\n`)
        break
    }
  }

  private handleProjection(event: TrustEvent): void {
    const filePath    = event.filePath    as string
    const level       = event.level       as number
    const tokenCount  = event.tokenCount  as number
    const source      = event.source      as string
    const guardPassed = event.guardPassed as boolean
    const budgetTokens  = event.budgetTokens  as number | undefined
    const budgetCeiling = event.budgetCeiling as number | undefined

    this.stats.projByLevel[level] = (this.stats.projByLevel[level] ?? 0) + 1
    if (!guardPassed) this.stats.guardBlocked++

    if (budgetTokens != null && budgetCeiling != null) {
      this.fileBudget.set(filePath, { tokens: budgetTokens, ceiling: budgetCeiling })
    }

    const budget    = this.fileBudget.get(filePath)
    const budgetStr = budget ? ` [budget: ${budget.tokens}/${budget.ceiling}tok]` : ""
    const guard     = guardPassed ? "" : " ✗guard"
    process.stdout.write(`  ✓ [PROJ L${level}]   ${filePath} ${tokenCount}tok (${source})${budgetStr}${guard}\n`)
  }

  private handlePlan(event: TrustEvent): void {
    const steps = event.steps as string[]
    const files = (event.files_involved as string[] | undefined) ?? []
    process.stdout.write(`\n  📋 [PLAN]       ${this.t.planHeader} (${steps.length}):\n`)
    steps.forEach((s, i) => process.stdout.write(`             ${i + 1}. ${s}\n`))
    if (files.length > 0) {
      process.stdout.write(`             ${this.t.planFiles} ${files.join(", ")}\n`)
    }
    process.stdout.write("\n")
  }

  private handleAtomicWrite(event: TrustEvent): void {
    const action = event.action as string
    if (action === "queued") {
      process.stdout.write(`  ⏳ [BUFFERED]   ${event.filePath} ${this.t.buffered}\n`)
    } else if (action === "flushing") {
      const count = event.count as number
      process.stdout.write(`\n  ⚠  [ATOMIC WRITE] ${this.t.atomicFlush} ${count} ${this.t.awaitingApproval}\n`)
    }
  }

  private handleCanary(event: TrustEvent): void {
    if (event.action === "planted") {
      process.stdout.write(`  🐦 [CANARY]     planted ${event.count} tokens\n`)
    } else if (event.action === "checked" && (event.leaked as number) > 0) {
      process.stdout.write(`  🚨 [CANARY]     ${event.leaked}/${event.planted} ${this.t.canaryLeak}\n`)
    }
  }

  /**
   * Session 结束时输出结构化摘要。
   * 代替 run.ts 中原有的多行 console.log 块。
   */
  printSessionSummary(opts: {
    sessionId: string
    iterations: number
    budgetStats: { trackedFiles: number; totalTokens: number; totalAsks: number }
    tokenUsage: { promptTokens: number; completionTokens: number }
    canaryResult?: { planted: number; leaked: number; safe: boolean }
    auditPath?: string
  }): void {
    const s = this.stats
    const t = this.t
    console.log()
    console.log("═".repeat(60))
    console.log(`✅ ${t.sessionDone} ${opts.sessionId}`)
    console.log(`   ${t.iterations} ${opts.iterations}`)
    console.log()

    // Gate verdict distribution
    const gateTotal = s.pass + s.proxyRead + s.proxyWrite + s.deny + s.redact
    console.log(`  ${t.toolStats} (${gateTotal}):`)
    if (s.pass > 0)       console.log(`    ✓ PASS         ${s.pass}`)
    if (s.proxyRead > 0)  console.log(`    ⟳ PROXY_READ   ${s.proxyRead}`)
    if (s.proxyWrite > 0) console.log(`    ⚠  PROXY_WRITE  ${s.proxyWrite}`)
    if (s.redact > 0)     console.log(`    ✓ REDACT       ${s.redact}`)
    if (s.deny > 0)       console.log(`    ✗ DENY         ${s.deny}`)
    if (s.warn > 0)       console.log(`    ⚠  WARN (downgrade) ${s.warn}`)

    // Projection summary
    const projTotal = s.projByLevel.reduce((a, b) => a + b, 0)
    if (projTotal > 0) {
      console.log()
      console.log(`  ${t.projStats} (${projTotal}):`)
      for (let i = 0; i <= 3; i++) {
        if (s.projByLevel[i] > 0) console.log(`    L${i}  ${s.projByLevel[i]}`)
      }
      if (s.guardBlocked > 0) console.log(`    ${t.guardBlocked}  ${s.guardBlocked}`)
    }

    // Per-file budget progress bars
    if (this.fileBudget.size > 0) {
      console.log()
      console.log(`  ${t.budgetBar}`)
      for (const [fp, b] of this.fileBudget) {
        const pct    = b.ceiling > 0 ? Math.round(b.tokens / b.ceiling * 100) : 0
        const filled = Math.min(10, Math.round(pct / 10))
        const bar    = "█".repeat(filled) + "░".repeat(10 - filled)
        console.log(`    [${bar}] ${b.tokens}/${b.ceiling}tok (${pct}%)  ${fp}`)
      }
      console.log(`    ${t.askCount} ${opts.budgetStats.totalAsks}`)
    }

    // API token usage
    console.log()
    console.log(`  ${t.apiUsage} ${opts.tokenUsage.promptTokens} prompt + ${opts.tokenUsage.completionTokens} completion tokens`)

    // Canary result
    if (opts.canaryResult) {
      const c = opts.canaryResult
      if (c.safe) {
        console.log(`  🐦 Canary: ${c.planted} ${t.canaryOk} (canary_test.passed: true)`)
      } else {
        console.error(`  🚨 Canary: ${c.leaked}/${c.planted} ${t.canaryLeak} (canary_test.passed: false)`)
      }
    }

    console.log()
    if (opts.auditPath) console.log(`📋 ${t.auditLog} ${opts.auditPath}`)
    console.log(`   ${t.resumeCmd} trust-agent run --resume ${opts.sessionId}`)
    console.log()
  }

  /** 仅供测试使用：返回当前统计快照 */
  getStats(): Readonly<Stats> {
    return { ...this.stats, projByLevel: [...this.stats.projByLevel] }
  }

  /** 仅供测试使用：返回当前文件预算快照 */
  getFileBudget(): ReadonlyMap<string, FileBudget> {
    return this.fileBudget
  }
}

// ───── 辅助：DENY 原因 → 改进建议 ─────────────────────────────

/**
 * Maps a DENY reason string to an actionable suggestion.
 * Returns undefined when no suggestion applies.
 */
export function getDenySuggestion(reason?: string, prefix = "Suggestion:"): string | undefined {
  if (!reason) return undefined
  if (reason.includes("信息预算已耗尽") || reason.includes("info budget")) {
    return `${prefix} use ask_high_trust to retrieve the information you need`
  }
  if (reason.includes("intent 包含疑似注入") || reason.includes("注入指令") || reason.includes("injection")) {
    return `${prefix} revise the intent description to remove system commands or control statements`
  }
  if (reason.includes("ask_high_trust 次数") || reason.includes("ask_high_trust limit")) {
    return `${prefix} ask_high_trust limit reached — consolidate questions or start a new session`
  }
  return undefined
}
