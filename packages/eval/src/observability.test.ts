/**
 * Sprint 4 — 可观测性测试
 *
 * 验证 CliReporter 事件处理、统计累积和 DENY 建议逻辑。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { CliReporter, getDenySuggestion } from "../../cli/src/reporter"

// ── 辅助：捕获 process.stdout.write 输出 ─────────────────────

function captureOutput(fn: () => void): string {
  const chunks: string[] = []
  const orig = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk: string | Uint8Array, ...args: unknown[]) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString())
    return true
  }
  try {
    fn()
  } finally {
    process.stdout.write = orig
  }
  return chunks.join("")
}

// ── Scenario 1: Gate 事件处理 ─────────────────────────────────

describe("CliReporter: gate 事件", () => {
  let reporter: CliReporter

  beforeEach(() => { reporter = new CliReporter() })

  test("PASS 事件输出带文件名和计时", () => {
    const out = captureOutput(() =>
      reporter.handle({ type: "gate", verdict: "PASS", toolName: "read", filePath: "src/utils.ts", durationMs: 12 })
    )
    expect(out).toContain("[PASS]")
    expect(out).toContain("read")
    expect(out).toContain("src/utils.ts")
    expect(out).toContain("(12ms)")
  })

  test("PROXY_READ 事件输出投影提示", () => {
    const out = captureOutput(() =>
      reporter.handle({ type: "gate", verdict: "PROXY_READ", toolName: "read", filePath: "src/engine.ts" })
    )
    expect(out).toContain("[PROXY_READ]")
    expect(out).toContain("src/engine.ts")
    expect(out).toContain("projecting")
  })

  test("PROXY_WRITE 事件输出警告", () => {
    const out = captureOutput(() =>
      reporter.handle({ type: "gate", verdict: "PROXY_WRITE", toolName: "edit", filePath: "src/engine.ts" })
    )
    expect(out).toContain("[PROXY_WRITE]")
    expect(out).toContain("src/engine.ts")
  })

  test("DENY 事件输出原因和建议（预算耗尽）", () => {
    const out = captureOutput(() =>
      reporter.handle({
        type: "gate",
        verdict: "DENY",
        toolName: "read",
        filePath: "src/engine.ts",
        reason: "信息预算已耗尽: src/engine.ts。建议使用 ask_high_trust 获取所需信息。",
      })
    )
    expect(out).toContain("[DENY]")
    expect(out).toContain("信息预算已耗尽")
    expect(out).toContain("ask_high_trust")
  })

  test("WARN 事件输出注入降级提示", () => {
    const out = captureOutput(() =>
      reporter.handle({
        type: "gate",
        verdict: "WARN",
        toolName: "read",
        filePath: "src/engine.ts",
        reason: "Prompt Injection 检测到，投影降级到 L1",
      })
    )
    expect(out).toContain("[WARN]")
    expect(out).toContain("Prompt Injection")
  })

  test("PASS/DENY/PROXY_READ 正确累积统计", () => {
    reporter.handle({ type: "gate", verdict: "PASS",       toolName: "glob" })
    reporter.handle({ type: "gate", verdict: "PASS",       toolName: "bash" })
    reporter.handle({ type: "gate", verdict: "PROXY_READ", toolName: "read", filePath: "src/a.ts" })
    reporter.handle({ type: "gate", verdict: "DENY",       toolName: "read", reason: "信息预算已耗尽: src/a.ts。" })
    const stats = reporter.getStats()
    expect(stats.pass).toBe(2)
    expect(stats.proxyRead).toBe(1)
    expect(stats.deny).toBe(1)
  })
})

// ── Scenario 2: Projection 事件处理 ──────────────────────────

describe("CliReporter: projection 事件", () => {
  let reporter: CliReporter

  beforeEach(() => { reporter = new CliReporter() })

  test("投影事件输出 level、tokenCount、source", () => {
    const out = captureOutput(() =>
      reporter.handle({
        type: "projection",
        filePath: "src/engine.ts",
        level: 1,
        tokenCount: 211,
        source: "treesitter",
        guardPassed: true,
      })
    )
    expect(out).toContain("[PROJ L1]")
    expect(out).toContain("src/engine.ts")
    expect(out).toContain("211tok")
    expect(out).toContain("treesitter")
  })

  test("投影事件含预算字段时输出 [budget: X/Ytok]", () => {
    const out = captureOutput(() =>
      reporter.handle({
        type: "projection",
        filePath: "src/engine.ts",
        level: 2,
        tokenCount: 342,
        source: "model",
        guardPassed: true,
        budgetTokens: 342,
        budgetCeiling: 4096,
      })
    )
    expect(out).toContain("[budget: 342/4096tok]")
  })

  test("没有预算字段时不输出 budget 字符串", () => {
    const out = captureOutput(() =>
      reporter.handle({
        type: "projection",
        filePath: "src/engine.ts",
        level: 1,
        tokenCount: 100,
        source: "treesitter",
        guardPassed: true,
      })
    )
    expect(out).not.toContain("[budget:")
  })

  test("guard 未通过时输出 ✗guard 标记", () => {
    const out = captureOutput(() =>
      reporter.handle({
        type: "projection",
        filePath: "src/engine.ts",
        level: 2,
        tokenCount: 400,
        source: "model",
        guardPassed: false,
        budgetTokens: 400,
        budgetCeiling: 4096,
      })
    )
    expect(out).toContain("✗guard")
    expect(reporter.getStats().guardBlocked).toBe(1)
  })

  test("投影统计按 level 正确累积", () => {
    reporter.handle({ type: "projection", filePath: "a.ts", level: 1, tokenCount: 100, source: "treesitter", guardPassed: true })
    reporter.handle({ type: "projection", filePath: "b.ts", level: 2, tokenCount: 200, source: "model",      guardPassed: true })
    reporter.handle({ type: "projection", filePath: "c.ts", level: 2, tokenCount: 150, source: "model",      guardPassed: true })
    const stats = reporter.getStats()
    expect(stats.projByLevel[1]).toBe(1)
    expect(stats.projByLevel[2]).toBe(2)
  })

  test("文件预算在 getFileBudget() 中正确追踪", () => {
    reporter.handle({
      type: "projection",
      filePath: "src/engine.ts",
      level: 2,
      tokenCount: 342,
      source: "model",
      guardPassed: true,
      budgetTokens: 342,
      budgetCeiling: 4096,
    })
    const budget = reporter.getFileBudget().get("src/engine.ts")
    expect(budget).toBeDefined()
    expect(budget!.tokens).toBe(342)
    expect(budget!.ceiling).toBe(4096)
  })
})

// ── Scenario 3: DENY 建议逻辑 ────────────────────────────────

describe("getDenySuggestion", () => {
  test("信息预算耗尽 → ask_high_trust 建议", () => {
    const s = getDenySuggestion("信息预算已耗尽: src/engine.ts。建议使用 ask_high_trust 获取所需信息。")
    expect(s).toBeDefined()
    expect(s).toContain("ask_high_trust")
  })

  test("intent 注入 → 修改意图建议", () => {
    const s = getDenySuggestion("PROXY_WRITE intent 包含疑似注入指令，已拒绝修改 src/engine.ts")
    expect(s).toBeDefined()
    expect(s).toContain("intent")
  })

  test("ask_high_trust 次数上限 → session 上限建议", () => {
    const s = getDenySuggestion("ask_high_trust 次数已达上限。")
    expect(s).toBeDefined()
    expect(s).toContain("ask_high_trust")
  })

  test("未知 DENY 原因 → 不返回建议", () => {
    const s = getDenySuggestion("Trust Gate internal error")
    expect(s).toBeUndefined()
  })

  test("undefined 原因 → 不返回建议", () => {
    const s = getDenySuggestion(undefined)
    expect(s).toBeUndefined()
  })
})

// ── Scenario 4: Canary 事件 ───────────────────────────────────

describe("CliReporter: canary 事件", () => {
  let reporter: CliReporter

  beforeEach(() => { reporter = new CliReporter() })

  test("planted 事件显示植入数量", () => {
    const out = captureOutput(() =>
      reporter.handle({ type: "canary", action: "planted", count: 2 })
    )
    expect(out).toContain("🐦")
    expect(out).toContain("2")
  })

  test("checked 且有泄露时显示警告", () => {
    const out = captureOutput(() =>
      reporter.handle({ type: "canary", action: "checked", leaked: 1, planted: 2 })
    )
    expect(out).toContain("🚨")
    expect(out).toContain("1/2")
  })

  test("checked 且无泄露时不输出任何内容", () => {
    const out = captureOutput(() =>
      reporter.handle({ type: "canary", action: "checked", leaked: 0, planted: 2 })
    )
    expect(out).toBe("")
  })
})
