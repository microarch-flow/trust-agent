import { appendFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "fs"
import { join, dirname } from "path"
import { createHmac, randomBytes } from "crypto"
import type { AuditEvent } from "../types"

export type AuditVerifyResult = {
  sessionId: string
  totalEntries: number
  validEntries: number
  tampered: number
  missing: number        // entries without signature
  passed: boolean
}

export class AuditLogger {
  private auditDir: string
  /** session 级签名密钥缓存（内存） */
  private sessionKeys = new Map<string, string>()

  constructor(projectRoot: string) {
    this.auditDir = join(projectRoot, ".trust-proxy", "audit")
    mkdirSync(this.auditDir, { recursive: true })
  }

  private getSessionKey(sessionId: string): string {
    if (this.sessionKeys.has(sessionId)) return this.sessionKeys.get(sessionId)!
    // 尝试从磁盘加载（用于 verify 路径）
    const keyPath = join(this.auditDir, `${sessionId}.key`)
    if (existsSync(keyPath)) {
      const k = readFileSync(keyPath, "utf-8").trim()
      this.sessionKeys.set(sessionId, k)
      return k
    }
    // 生成新密钥并持久化
    const key = randomBytes(32).toString("hex")
    writeFileSync(keyPath, key, { mode: 0o600 })
    this.sessionKeys.set(sessionId, key)
    return key
  }

  private sign(payload: string, key: string): string {
    return createHmac("sha256", key).update(payload).digest("hex").slice(0, 16)
  }

  log(event: AuditEvent): void {
    const sessionId = "sessionId" in event ? event.sessionId : "unknown"
    const file = join(this.auditDir, `${sessionId}.ndjson`)
    mkdirSync(dirname(file), { recursive: true })

    const key = this.getSessionKey(sessionId)
    const payload = JSON.stringify(event)
    const sig = this.sign(payload, key)

    appendFileSync(file, JSON.stringify({ ...event, _sig: sig }) + "\n")
  }

  logGate(
    sessionId: string,
    toolName: string,
    verdict: string,
    filePath?: string,
    reason?: string,
    durationMs = 0,
  ): void {
    this.log({
      type: "gate",
      timestamp: new Date().toISOString(),
      sessionId,
      toolName,
      filePath,
      verdict,
      reason,
      durationMs,
    })
  }

  logProjection(
    sessionId: string,
    filePath: string,
    level: number,
    tokenCount: number,
    source: "cache" | "stat" | "treesitter" | "model",
    guardPassed: boolean,
  ): void {
    this.log({
      type: "projection",
      timestamp: new Date().toISOString(),
      sessionId,
      filePath,
      level: level as 0 | 1 | 2 | 3,
      tokenCount,
      source,
      guardPassed,
    })
  }

  logHighTrustCall(
    sessionId: string,
    model: string,
    filePath: string,
    durationMs: number,
  ): void {
    this.log({
      type: "hightrust_call",
      timestamp: new Date().toISOString(),
      sessionId,
      model,
      filePath,
      durationMs,
    })
  }

  getLogPath(sessionId: string): string {
    return join(this.auditDir, `${sessionId}.ndjson`)
  }

  /**
   * 验证审计日志的 HMAC 签名完整性。
   * 使用与写入时相同的 session key 重新计算每条记录的签名。
   */
  verifyLog(sessionId: string): AuditVerifyResult {
    const logPath = join(this.auditDir, `${sessionId}.ndjson`)
    if (!existsSync(logPath)) {
      return { sessionId, totalEntries: 0, validEntries: 0, tampered: 0, missing: 0, passed: false }
    }

    const key = this.getSessionKey(sessionId)
    const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean)

    let validEntries = 0
    let tampered = 0
    let missing = 0

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        const storedSig = entry._sig as string | undefined
        if (!storedSig) { missing++; continue }

        // 重新计算：去掉 _sig 字段后签名原始 event
        const { _sig, ...event } = entry
        const payload = JSON.stringify(event)
        const expected = this.sign(payload, key)

        if (expected === storedSig) {
          validEntries++
        } else {
          tampered++
        }
      } catch {
        tampered++
      }
    }

    const total = lines.length
    return {
      sessionId,
      totalEntries: total,
      validEntries,
      tampered,
      missing,
      passed: tampered === 0 && missing === 0 && total > 0,
    }
  }
}
