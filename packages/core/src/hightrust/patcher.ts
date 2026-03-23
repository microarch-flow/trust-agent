import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "fs"
import { dirname, join, basename } from "path"
import type { HighTrustModelConfig } from "../types"
import type { Guard } from "../guard/guard"
import type { AuditLogger } from "../audit/logger"

export type PatchRequest = {
  filePath: string
  intent: string
  context?: string
}

export type PatchResult = {
  success: boolean
  diff: string
  linesChanged: number
  guardPassed: boolean
  error?: string
  backupPath?: string
}

/**
 * Patcher: 根据修改意图，调用本地模型生成 diff 并应用到文件。
 *
 * 流程：
 * 1. 读取源文件
 * 2. 备份源文件
 * 3. 调用模型生成修改后的完整文件（而非 diff，更可靠）
 * 4. Guard 检查生成内容
 * 5. 写入文件
 */
export class Patcher {
  private modelConfig: HighTrustModelConfig
  private guard: Guard
  private auditLogger: AuditLogger
  private sessionId: string
  private backupDir: string

  constructor(
    modelConfig: HighTrustModelConfig,
    guard: Guard,
    auditLogger: AuditLogger,
    sessionId: string,
    projectRoot: string,
  ) {
    this.modelConfig = modelConfig
    this.guard = guard
    this.auditLogger = auditLogger
    this.sessionId = sessionId
    this.backupDir = join(projectRoot, ".trust-proxy", "backups", sessionId)
  }

  async patch(req: PatchRequest): Promise<PatchResult> {
    const start = Date.now()

    // 1. 读取源文件
    let source: string
    try {
      source = readFileSync(req.filePath, "utf-8")
    } catch (err) {
      return {
        success: false,
        diff: "",
        linesChanged: 0,
        guardPassed: false,
        error: `无法读取文件: ${err}`,
      }
    }

    // 2. 备份
    const backupPath = this.backup(req.filePath, source)

    // 3. 调用模型生成修改
    let modified: string
    try {
      modified = await this.callPatcherModel(source, req.filePath, req.intent, req.context)
    } catch (err) {
      return {
        success: false,
        diff: "",
        linesChanged: 0,
        guardPassed: false,
        error: `模型调用失败: ${err}`,
        backupPath,
      }
    }

    // 4. 计算 diff
    const diff = computeDiff(source, modified, req.filePath)
    const linesChanged = diff.split("\n").filter(l => l.startsWith("+") || l.startsWith("-")).length

    if (linesChanged === 0) {
      return {
        success: false,
        diff: "",
        linesChanged: 0,
        guardPassed: true,
        error: "模型未产生任何修改",
        backupPath,
      }
    }

    // 5. Guard 检查 diff（确保 diff 内容回传给 low-trust LLM 时安全）
    // 注意：这里不检查完整修改后的文件（那仍在 secret 域内），
    //       只检查要回传给 cloud LLM 的 diff 摘要
    const diffSummary = summarizeDiff(diff, linesChanged)
    const guardResult = await this.guard.check({
      content: diffSummary,
      sourceFiles: [req.filePath],
      contentType: "patch_diff",
    })

    // 6. 写入文件
    if (guardResult.passed) {
      writeFileSync(req.filePath, modified)
    }

    this.auditLogger.logHighTrustCall(
      this.sessionId,
      this.modelConfig.model,
      req.filePath,
      Date.now() - start,
    )

    return {
      success: guardResult.passed,
      diff: guardResult.passed ? diffSummary : "[GUARD BLOCKED] diff 包含敏感信息，未应用修改",
      linesChanged,
      guardPassed: guardResult.passed,
      backupPath,
    }
  }

  /**
   * 回滚到备份
   */
  rollback(filePath: string, backupPath: string): boolean {
    try {
      copyFileSync(backupPath, filePath)
      return true
    } catch {
      return false
    }
  }

  private backup(filePath: string, content: string): string {
    mkdirSync(this.backupDir, { recursive: true })
    const ts = Date.now()
    const name = `${basename(filePath)}.${ts}.bak`
    const backupPath = join(this.backupDir, name)
    writeFileSync(backupPath, content)
    return backupPath
  }

  private async callPatcherModel(
    source: string,
    filePath: string,
    intent: string,
    context?: string,
  ): Promise<string> {
    const prompt = `你是一个精确的代码修改助手。请根据修改意图修改以下代码。

文件: ${filePath}
${context ? `背景: ${context}\n` : ""}
修改意图: ${intent}

当前源码:
\`\`\`
${source}
\`\`\`

请输出修改后的**完整文件内容**。
规则:
- 只输出代码，不要解释
- 不要输出 markdown 代码块标记
- 保持文件格式和缩进风格一致
- 只做意图中描述的修改，不改动其他部分`

    const url = `${this.modelConfig.baseURL.replace(/\/$/, "")}/chat/completions`
    const timeout = this.modelConfig.timeoutMs || 120000

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (this.modelConfig.apiKey) {
      headers["Authorization"] = `Bearer ${this.modelConfig.apiKey}`
    }

    const body = {
      model: this.modelConfig.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: this.modelConfig.maxTokens || 4096,
      temperature: 0.0,
      stream: false,
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`API error ${response.status}: ${text.slice(0, 200)}`)
      }

      const data = (await response.json()) as {
        choices: Array<{ message: { content: string } }>
      }

      let content = data.choices?.[0]?.message?.content || ""

      // 清理可能的 markdown 代码块包裹
      content = stripCodeBlock(content)

      return content
    } finally {
      clearTimeout(timer)
    }
  }
}

// ===== 辅助函数 =====

/**
 * 简单的行级 diff（不依赖外部库）
 */
function computeDiff(original: string, modified: string, filePath: string): string {
  const origLines = original.split("\n")
  const modLines = modified.split("\n")

  const lines: string[] = [`--- a/${basename(filePath)}`, `+++ b/${basename(filePath)}`]

  // 简单的逐行比较（LCS 太重，这里用贪心匹配）
  let i = 0
  let j = 0

  while (i < origLines.length || j < modLines.length) {
    if (i < origLines.length && j < modLines.length && origLines[i] === modLines[j]) {
      // 相同行
      i++
      j++
      continue
    }

    // 找差异段
    const contextStart = Math.max(0, i - 1)
    lines.push(`@@ -${i + 1} +${j + 1} @@`)

    // 尝试找到下一个匹配点
    let matchI = -1
    let matchJ = -1
    outer: for (let di = 0; di < 20 && i + di < origLines.length; di++) {
      for (let dj = 0; dj < 20 && j + dj < modLines.length; dj++) {
        if (origLines[i + di] === modLines[j + dj] && origLines[i + di].trim().length > 0) {
          matchI = i + di
          matchJ = j + dj
          break outer
        }
      }
    }

    if (matchI >= 0) {
      // 输出删除的行
      while (i < matchI) {
        lines.push(`-${origLines[i]}`)
        i++
      }
      // 输出添加的行
      while (j < matchJ) {
        lines.push(`+${modLines[j]}`)
        j++
      }
    } else {
      // 无法找到匹配，输出剩余所有行
      while (i < origLines.length) {
        lines.push(`-${origLines[i]}`)
        i++
      }
      while (j < modLines.length) {
        lines.push(`+${modLines[j]}`)
        j++
      }
    }
  }

  return lines.join("\n")
}

/**
 * 生成 diff 的安全摘要（用于回传给 cloud LLM）
 * 不包含具体代码行，只描述修改概况
 */
function summarizeDiff(diff: string, linesChanged: number): string {
  const added = diff.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++")).length
  const removed = diff.split("\n").filter(l => l.startsWith("-") && !l.startsWith("---")).length

  return `[PATCH APPLIED] ${linesChanged} lines changed (+${added} -${removed})`
}

function stripCodeBlock(content: string): string {
  // 移除 ```language ... ``` 包裹
  const match = content.match(/^```\w*\n([\s\S]*?)\n```\s*$/m)
  if (match) return match[1]

  // 移除开头的 ``` 行
  if (content.startsWith("```")) {
    const lines = content.split("\n")
    lines.shift() // 移除第一行
    if (lines[lines.length - 1]?.trim() === "```") {
      lines.pop() // 移除最后一行
    }
    return lines.join("\n")
  }

  return content
}
