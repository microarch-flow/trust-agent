import { readFileSync, writeFileSync } from "fs"
import { randomUUID } from "crypto"

export type CanaryToken = {
  id: string
  token: string
  filePath: string
  insertedAt: string
  /** 原始行内容（用于恢复） */
  originalLine: string
  lineNumber: number
}

export type CanaryResult = {
  token: CanaryToken
  leaked: boolean
  foundIn?: string
}

/**
 * Canary 测试框架
 *
 * 在 secret 文件中植入唯一标记（canary token），
 * 然后检测这些标记是否出现在发送给 cloud LLM 的数据中。
 * 如果出现，说明存在泄露路径。
 */
export class CanaryTester {
  private tokens: CanaryToken[] = []

  /**
   * 在 secret 文件中植入 canary token
   * 以注释形式插入，不影响代码功能
   */
  plant(filePath: string): CanaryToken {
    const source = readFileSync(filePath, "utf-8")
    const lines = source.split("\n")

    // 生成唯一 token
    const token = `CANARY_${randomUUID().replace(/-/g, "").slice(0, 16)}`

    // 找一个合适的插入点（文件开头附近的空行或注释后）
    let insertLine = 0
    for (let i = 0; i < Math.min(lines.length, 10); i++) {
      const trimmed = lines[i].trim()
      if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("#")) {
        insertLine = i + 1
        break
      }
    }

    // 检测注释风格
    const ext = filePath.split(".").pop() || ""
    const commentPrefix = getCommentPrefix(ext)
    const canaryLine = `${commentPrefix} ${token}`

    // 插入 canary
    const originalLine = lines[insertLine] || ""
    lines.splice(insertLine, 0, canaryLine)
    writeFileSync(filePath, lines.join("\n"))

    const canary: CanaryToken = {
      id: randomUUID().slice(0, 8),
      token,
      filePath,
      insertedAt: new Date().toISOString(),
      originalLine,
      lineNumber: insertLine,
    }

    this.tokens.push(canary)
    return canary
  }

  /**
   * 检测 canary token 是否泄露到给定内容中
   */
  check(content: string): CanaryResult[] {
    return this.tokens.map(token => ({
      token,
      leaked: content.includes(token.token),
      foundIn: content.includes(token.token)
        ? extractContext(content, token.token)
        : undefined,
    }))
  }

  /**
   * 批量检测：检查多段内容
   */
  checkAll(contents: string[]): CanaryResult[] {
    const combined = contents.join("\n")
    return this.check(combined)
  }

  /**
   * 从文件中移除所有已植入的 canary token，恢复原文
   */
  restore(): { restored: number; failed: string[] } {
    let restored = 0
    const failed: string[] = []

    for (const canary of this.tokens) {
      try {
        const source = readFileSync(canary.filePath, "utf-8")
        const lines = source.split("\n")

        // 找到并移除 canary 行
        const idx = lines.findIndex(l => l.includes(canary.token))
        if (idx >= 0) {
          lines.splice(idx, 1)
          writeFileSync(canary.filePath, lines.join("\n"))
          restored++
        } else {
          failed.push(canary.filePath)
        }
      } catch {
        failed.push(canary.filePath)
      }
    }

    this.tokens = []
    return { restored, failed }
  }

  /**
   * 获取已植入的 canary tokens
   */
  getTokens(): readonly CanaryToken[] {
    return this.tokens
  }

  /**
   * 生成检测报告
   */
  report(results: CanaryResult[]): string {
    const lines: string[] = ["=== Canary Test Report ===", ""]
    const leaked = results.filter(r => r.leaked)
    const safe = results.filter(r => !r.leaked)

    lines.push(`总计: ${results.length} 个 canary token`)
    lines.push(`安全: ${safe.length}`)
    lines.push(`泄露: ${leaked.length}`)
    lines.push("")

    if (leaked.length > 0) {
      lines.push("⚠ 泄露详情:")
      for (const r of leaked) {
        lines.push(`  - ${r.token.filePath}`)
        lines.push(`    Token: ${r.token.token}`)
        if (r.foundIn) {
          lines.push(`    上下文: ...${r.foundIn}...`)
        }
      }
    } else {
      lines.push("✓ 所有 canary token 均未泄露。系统安全。")
    }

    return lines.join("\n")
  }
}

// ===== 辅助函数 =====

function getCommentPrefix(ext: string): string {
  switch (ext) {
    case "py": return "#"
    case "html": case "xml": return "<!--"
    case "css": return "/*"
    default: return "//"
  }
}

function extractContext(content: string, token: string): string {
  const idx = content.indexOf(token)
  if (idx < 0) return ""
  const start = Math.max(0, idx - 30)
  const end = Math.min(content.length, idx + token.length + 30)
  return content.slice(start, end)
}
