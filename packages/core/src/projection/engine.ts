import { readFileSync, statSync } from "fs"
import { createHash } from "crypto"
import { basename } from "path"
import { ProjectionCache } from "./cache"
import type { ProjectionLevel, ProjectionResult } from "../types"

export type ProjectionRequest = {
  filePath: string
  level: ProjectionLevel
  language?: string
}

export type ModelProjector = {
  project(source: string, filePath: string, level: ProjectionLevel): Promise<string>
}

export class ProjectionEngine {
  private cache: ProjectionCache
  private modelProjector?: ModelProjector

  constructor(projectRoot: string, modelProjector?: ModelProjector) {
    this.cache = new ProjectionCache(projectRoot)
    this.modelProjector = modelProjector
  }

  async project(req: ProjectionRequest): Promise<ProjectionResult> {
    const sourceHash = this.hashFile(req.filePath)

    // 查缓存
    const cached = this.cache.get(req.filePath, req.level, sourceHash)
    if (cached) return cached

    // 按级别生成
    let result: ProjectionResult
    switch (req.level) {
      case 0:
        result = this.projectLevel0(req.filePath, sourceHash)
        break
      case 1:
        result = this.projectLevel1(req.filePath, sourceHash)
        break
      case 2:
      case 3:
        result = await this.projectWithModel(req, sourceHash)
        break
      default:
        result = this.projectLevel0(req.filePath, sourceHash)
    }

    this.cache.set(req.filePath, req.level, result)
    return result
  }

  /** Level 0: 文件存在性信息 */
  private projectLevel0(filePath: string, sourceHash: string): ProjectionResult {
    const stat = statSync(filePath)
    const source = readFileSync(filePath, "utf-8")
    const lineCount = source.split("\n").length
    const name = basename(filePath)

    const content = `[PROJECTED L0] ${name}\nFile exists, ${lineCount} lines, ${stat.size} bytes`

    return {
      content,
      level: 0,
      format: "text",
      tokenCount: estimateTokens(content),
      sourceHash,
      generatedAt: new Date().toISOString(),
      generatedBy: "stat",
    }
  }

  /** Level 1: 函数签名和导出（简化版，tree-sitter 后续替换） */
  private projectLevel1(filePath: string, sourceHash: string): ProjectionResult {
    const source = readFileSync(filePath, "utf-8")
    const language = detectLanguage(filePath)
    const signatures = extractSignatures(source, language)

    const lines = [`[PROJECTED L1] ${basename(filePath)}`, ""]
    if (signatures.functions.length > 0) {
      lines.push("## Exports")
      for (const fn of signatures.functions) {
        lines.push(`- ${fn}`)
      }
      lines.push("")
    }
    if (signatures.classes.length > 0) {
      lines.push("## Classes")
      for (const cls of signatures.classes) {
        lines.push(`- ${cls}`)
      }
      lines.push("")
    }
    if (signatures.imports.length > 0) {
      lines.push("## Dependencies")
      lines.push(signatures.imports.join(", "))
      lines.push("")
    }
    lines.push(`Lines: ${source.split("\n").length}`)

    const content = lines.join("\n")
    return {
      content,
      level: 1,
      format: "text",
      tokenCount: estimateTokens(content),
      sourceHash,
      generatedAt: new Date().toISOString(),
      generatedBy: "treesitter",
    }
  }

  /** Level 2-3: 调用模型生成 */
  private async projectWithModel(req: ProjectionRequest, sourceHash: string): Promise<ProjectionResult> {
    if (!this.modelProjector) {
      // 没有配置模型，降级到 Level 1
      return this.projectLevel1(req.filePath, sourceHash)
    }

    try {
      const source = readFileSync(req.filePath, "utf-8")
      const content = await this.modelProjector.project(source, req.filePath, req.level)

      if (!content) {
        // 模型返回空内容，降级到 Level 1
        return this.projectLevel1(req.filePath, sourceHash)
      }

      return {
        content: `[PROJECTED L${req.level}] ${basename(req.filePath)}\n\n${content}`,
        level: req.level,
        format: "json",
        tokenCount: estimateTokens(content),
        sourceHash,
        generatedAt: new Date().toISOString(),
        generatedBy: "model",
      }
    } catch {
      // 模型调用失败，降级到 Level 1（确保 proxyRead 能到达 recordProjection）
      return this.projectLevel1(req.filePath, sourceHash)
    }
  }

  invalidate(filePath: string): void {
    this.cache.invalidate(filePath)
  }

  getCacheStats() {
    return this.cache.getStats()
  }

  private hashFile(filePath: string): string {
    const content = readFileSync(filePath, "utf-8")
    return createHash("sha256").update(content).digest("hex").slice(0, 16)
  }
}

// ===== 辅助函数 =====

function estimateTokens(text: string): number {
  // 粗略估算：1 token ≈ 4 字符
  return Math.ceil(text.length / 4)
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || ""
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    py: "python", cpp: "cpp", cc: "cpp", cxx: "cpp", c: "c", h: "c",
    hpp: "cpp", go: "go", rs: "rust", java: "java", kt: "kotlin",
  }
  return map[ext] || "unknown"
}

type SignatureExtraction = {
  functions: string[]
  classes: string[]
  imports: string[]
}

/**
 * 简化的签名提取（正则版）
 * Phase 2 中替换为 tree-sitter
 */
function extractSignatures(source: string, language: string): SignatureExtraction {
  const functions: string[] = []
  const classes: string[] = []
  const imports: string[] = []

  const lines = source.split("\n")

  for (const line of lines) {
    const trimmed = line.trim()

    // imports
    if (/^(import |from |#include |require\()/.test(trimmed)) {
      imports.push(trimmed)
      continue
    }

    // 函数签名（简化匹配）
    // 安全原则：只提取 export 的公开接口，不暴露内部函数名
    switch (language) {
      case "typescript":
      case "javascript":
        if (/^export\s+(async\s+)?function\s+\w+/.test(trimmed)) {
          functions.push(extractUntilBrace(trimmed))
        } else if (/^export\s+(const|let)\s+\w+\s*=\s*(async\s+)?\(/.test(trimmed)) {
          functions.push(extractUntilBrace(trimmed))
        }
        if (/^export\s+(abstract\s+)?class\s+\w+/.test(trimmed)) {
          classes.push(extractUntilBrace(trimmed))
        }
        break

      case "python":
        // Python: 不以 _ 开头的顶层 def/class 视为公开
        if (/^(async\s+)?def\s+[^_]\w*/.test(trimmed)) {
          functions.push(trimmed.replace(/:.*$/, ""))
        }
        if (/^class\s+[^_]\w*/.test(trimmed)) {
          classes.push(trimmed.replace(/:.*$/, ""))
        }
        break

      case "cpp":
      case "c":
        // Enums: enum Foo / enum class Foo
        if (/^enum(\s+class)?\s+\w+/.test(trimmed)) {
          classes.push(extractUntilBrace(trimmed))
        }
        // Classes, structs, unions
        else if (/^(class|struct|union)\s+\w+/.test(trimmed)) {
          classes.push(extractUntilBrace(trimmed))
        }
        // Typedefs (struct/enum/union)
        else if (/^typedef\s+(struct|enum|union)(\s+\w+)?\s*(\{|$)/.test(trimmed)) {
          classes.push(trimmed.slice(0, 60))
        }
        // Function declarations (including API-macro prefixed like LLAMA_API, GGML_API)
        else if (
          /\w+\s*\(/.test(trimmed) &&
          !/^(if|else|for|while|do|switch|return|try|catch|#|\/\/)/.test(trimmed) &&
          !trimmed.startsWith("static inline") &&
          !trimmed.includes("=") // skip variable assignments
        ) {
          functions.push(extractUntilBrace(trimmed).slice(0, 80))
        }
        break

      case "go":
        // Go: 只有大写开头的是导出的
        if (/^func\s+[A-Z]/.test(trimmed) || /^func\s+\(\w+\s+\*?\w+\)\s+[A-Z]/.test(trimmed)) {
          functions.push(extractUntilBrace(trimmed))
        }
        if (/^type\s+[A-Z]\w+\s+struct/.test(trimmed)) {
          classes.push(extractUntilBrace(trimmed))
        }
        break
    }
  }

  return { functions, classes, imports }
}

function extractUntilBrace(line: string): string {
  const braceIdx = line.indexOf("{")
  if (braceIdx > 0) return line.slice(0, braceIdx).trim()
  return line.trim()
}
