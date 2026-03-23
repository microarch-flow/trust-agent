import { existsSync, readdirSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { AuditLogger } from "@trust-proxy/core"

export async function runStatus(args: string[]) {
  const projectRoot = resolve(process.cwd())
  const auditDir = join(projectRoot, ".trust-proxy", "audit")

  if (!existsSync(auditDir)) {
    console.log("📭 没有找到审计日志。尚未运行过 session。")
    return
  }

  // --verify 模式：检查审计日志 HMAC 签名
  if (args.includes("--verify")) {
    const targetId = args.find((a) => !a.startsWith("-"))
    await runVerify(projectRoot, auditDir, targetId)
    return
  }

  const sessionId = args[0]

  if (sessionId && !sessionId.startsWith("-")) {
    showSession(auditDir, sessionId)
  } else {
    listSessions(auditDir)
  }
}

async function runVerify(projectRoot: string, auditDir: string, sessionId?: string) {
  const logger = new AuditLogger(projectRoot)
  const sessions = sessionId
    ? [sessionId]
    : readdirSync(auditDir).filter((f) => f.endsWith(".ndjson")).map((f) => f.replace(".ndjson", ""))

  console.log(`🔐 审计日志签名验证 (${sessions.length} 个 session)\n`)

  let allPassed = true
  for (const sid of sessions) {
    const result = logger.verifyLog(sid)
    const icon = result.passed ? "✓" : "✗"
    const summary = result.passed
      ? `${result.totalEntries} 条记录全部有效`
      : `篡改: ${result.tampered}  缺签名: ${result.missing}  有效: ${result.validEntries}/${result.totalEntries}`
    console.log(`  ${icon} ${sid}  ${summary}`)
    if (!result.passed) allPassed = false
  }

  console.log()
  if (allPassed) {
    console.log("✅ 签名链完整，所有日志未被篡改")
  } else {
    console.error("❌ 检测到日志完整性异常，请调查")
    process.exit(1)
  }
}

function listSessions(auditDir: string) {
  const files = readdirSync(auditDir).filter((f) => f.endsWith(".ndjson"))

  if (files.length === 0) {
    console.log("📭 没有找到审计日志。")
    return
  }

  console.log(`📋 Session 列表 (${files.length} 个):\n`)

  for (const file of files.sort().reverse()) {
    const sessionId = file.replace(".ndjson", "")
    const content = readFileSync(join(auditDir, file), "utf-8").trim()
    const lines = content.split("\n")
    const eventCount = lines.length

    // 解析首尾事件获取时间范围
    let startTime = ""
    let endTime = ""
    try {
      const first = JSON.parse(lines[0])
      const last = JSON.parse(lines[lines.length - 1])
      startTime = first.timestamp || ""
      endTime = last.timestamp || ""
    } catch {
      // ignore
    }

    // 统计 verdict 分布 + 投影数
    const verdicts: Record<string, number> = {}
    let projCount = 0
    for (const line of lines) {
      try {
        const event = JSON.parse(line)
        if (event.type === "gate") {
          verdicts[event.verdict] = (verdicts[event.verdict] || 0) + 1
        } else if (event.type === "projection") {
          projCount++
        }
      } catch {
        // ignore
      }
    }

    const verdictStr = Object.entries(verdicts)
      .map(([k, v]) => `${k}:${v}`)
      .join(" ")
    const projStr = projCount > 0 ? `  投影:${projCount}` : ""

    console.log(`  ${sessionId}`)
    console.log(`    时间: ${startTime} → ${endTime}`)
    console.log(`    事件: ${eventCount}  判定: ${verdictStr || "N/A"}${projStr}`)
    console.log()
  }
}

function showSession(auditDir: string, sessionId: string) {
  const filePath = join(auditDir, `${sessionId}.ndjson`)

  if (!existsSync(filePath)) {
    console.error(`❌ 未找到 session: ${sessionId}`)
    return
  }

  const content = readFileSync(filePath, "utf-8").trim()
  const lines = content.split("\n").filter(Boolean)

  // ── 解析所有事件 ──────────────────────────────────────────
  const events: Record<string, unknown>[] = []
  for (const line of lines) {
    try { events.push(JSON.parse(line)) } catch { /* skip */ }
  }

  // ── 计算统计 ──────────────────────────────────────────────
  // Gate verdict 分布
  const verdicts: Record<string, number> = {}
  // Projection 分布 by level
  const projByLevel: Record<number, number> = {}
  let guardBlocked = 0
  // 每文件累积 tokens（来自 projection 事件）
  const fileTokens = new Map<string, number>()
  // DENY 原因列表
  const denyReasons: string[] = []
  // 时间范围
  let startTime = ""
  let endTime = ""

  for (const e of events) {
    const ts = (e.timestamp as string) || ""
    if (!startTime) startTime = ts
    endTime = ts

    if (e.type === "gate") {
      const v = (e.verdict as string) || "UNKNOWN"
      verdicts[v] = (verdicts[v] || 0) + 1
      if (v === "DENY" && e.reason) denyReasons.push(e.reason as string)
    } else if (e.type === "projection") {
      const lvl = (e.level as number) ?? 0
      projByLevel[lvl] = (projByLevel[lvl] || 0) + 1
      if (e.guardPassed === false) guardBlocked++
      const fp = e.filePath as string
      const tok = (e.tokenCount as number) || 0
      fileTokens.set(fp, (fileTokens.get(fp) || 0) + tok)
    }
  }

  // ── 输出摘要 ──────────────────────────────────────────────
  console.log(`📋 Session: ${sessionId}\n`)

  const startShort = startTime ? startTime.replace("T", " ").slice(0, 19) : "?"
  const endShort   = endTime   ? endTime.replace("T", " ").slice(0, 19)   : "?"
  console.log(`  时间范围: ${startShort} → ${endShort}`)
  console.log()

  // 工具调用统计
  const gateTotal = Object.values(verdicts).reduce((a, b) => a + b, 0)
  console.log(`  工具调用统计 (共 ${gateTotal} 次):`)
  for (const [v, n] of Object.entries(verdicts).sort()) {
    const icon = v === "PASS" || v === "REDACT" ? "✓" : v === "DENY" ? "✗" : "⟳"
    console.log(`    ${icon} ${v.padEnd(12)} ${n}`)
  }
  if (denyReasons.length > 0) {
    console.log(`\n  DENY 原因:`)
    for (const r of denyReasons) {
      console.log(`    - ${r}`)
    }
  }
  console.log()

  // 投影统计
  const projTotal = Object.values(projByLevel).reduce((a, b) => a + b, 0)
  if (projTotal > 0) {
    console.log(`  投影统计 (共 ${projTotal} 次):`)
    for (const lvl of [0, 1, 2, 3]) {
      if (projByLevel[lvl]) console.log(`    L${lvl}  ${projByLevel[lvl]}`)
    }
    if (guardBlocked > 0) console.log(`    Guard 拦截  ${guardBlocked}`)
    console.log()
  }

  // 每文件信息预算（token 用量）
  if (fileTokens.size > 0) {
    console.log(`  文件投影 token 用量:`)
    for (const [fp, tok] of fileTokens) {
      console.log(`    ${tok.toString().padStart(6)}tok  ${fp}`)
    }
    console.log()
  }

  console.log(`  总计 ${lines.length} 个事件`)
}
