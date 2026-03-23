import { readFileSync } from "fs"
import type { GuardResult, Violation, HighTrustModelConfig } from "../types"
import { callOpenAICompatible } from "../hightrust/api"

export type GuardInput = {
  content: string
  sourceFiles: string[]
  contentType: "projection" | "answer" | "patch_diff"
}

export type GuardConfig = {
  knownSafeTokens: string[]
  publicFiles: string[]
  minTokenLength: number
  minLineLength: number
  /** Layer 2: 控制流 n-gram 相似度阈值 (0~1)，默认 0.75 */
  structureSimilarityThreshold: number
  /** Layer 3: 是否启用 Meta-Guard 语义审查，默认 true */
  metaGuardEnabled: boolean
  /** Layer 3: Meta-Guard 最大 token 数，默认 20 */
  metaGuardMaxTokens: number
  /** Layer 3: Meta-Guard 使用的本地模型（取 answerer 或 projector） */
  metaGuardModel?: HighTrustModelConfig
}

const DEFAULT_CONFIG: GuardConfig = {
  knownSafeTokens: [],
  publicFiles: [],
  minTokenLength: 7,
  minLineLength: 24,
  structureSimilarityThreshold: 0.75,
  metaGuardEnabled: true,
  metaGuardMaxTokens: 20,
}

export class Guard {
  private config: GuardConfig
  private publicTokens: Set<string> | null = null
  /** 缓存每个 secret 文件的控制流序列 */
  private structureCache = new Map<string, string[]>()

  constructor(config: Partial<GuardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async check(input: GuardInput): Promise<GuardResult> {
    const start = Date.now()
    const violations: Violation[] = []

    if (this.publicTokens === null) {
      this.publicTokens = this.loadPublicTokens()
    }

    // ── Layer 1: Token 泄漏检测（含编码绕过检测）────────────────
    const internalTokens = this.extractInternalTokens(input.sourceFiles)
    // 同时检查原文和 base64/hex 解码后的内容
    const decodedContent = decodeEncodedChunks(input.content)
    for (const token of internalTokens) {
      if (input.content.includes(token)) {
        violations.push({ type: "token_leak", detail: token, severity: "high" })
      } else if (decodedContent !== input.content && decodedContent.includes(token)) {
        violations.push({
          type: "token_leak",
          detail: `[encoded] ${token}`,
          severity: "high",
        })
      }
    }

    // ── Layer 1b: 源码行泄漏检测（原有）─────────────────────────
    for (const file of input.sourceFiles) {
      let source: string
      try {
        source = readFileSync(file, "utf-8")
      } catch {
        continue
      }

      const lines = source.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim()
        if (line.length < this.config.minLineLength) continue
        if (isBoilerplate(line)) continue
        if (input.content.includes(line)) {
          violations.push({
            type: "line_leak",
            detail: `Line ${i + 1}: ${line.slice(0, 60)}...`,
            severity: "high",
          })
        }
      }
    }

    // ── Layer 2: 控制流结构指纹（新增）──────────────────────────
    const structViolation = this.checkStructure(input.content, input.sourceFiles)
    if (structViolation) {
      violations.push(structViolation)
    }

    // ── Layer 3: Meta-Guard 语义审查（新增）─────────────────────
    // 只在 L1/L2 层未发现严重问题、内容由模型生成时才启用（避免重复拦截）
    const highViolations = violations.filter(v => v.severity === "high").length
    if (
      highViolations === 0 &&
      this.config.metaGuardEnabled &&
      this.config.metaGuardModel &&
      (input.contentType === "projection" || input.contentType === "answer")
    ) {
      const metaViolation = await this.checkMetaGuard(input.content)
      if (metaViolation) {
        violations.push(metaViolation)
      }
    }

    return {
      passed: violations.filter((v) => v.severity === "high").length === 0,
      violations,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
    }
  }

  // ── Layer 2: 控制流结构指纹 ─────────────────────────────────

  /**
   * 提取文本中的控制流关键字序列
   * e.g. "if (x) { for (...) { return } }" → ["if", "for", "return"]
   */
  private getControlFlowSequence(text: string): string[] {
    const regex = /\b(if|else|for|while|do|switch|case|return|try|catch|finally|throw|break|continue)\b/g
    const seq: string[] = []
    let match
    while ((match = regex.exec(text)) !== null) {
      seq.push(match[1])
    }
    return seq
  }

  /**
   * N-gram Jaccard 相似度
   * 用 trigram 捕捉控制流顺序，而非仅集合存在
   */
  private ngramSimilarity(a: string[], b: string[], n = 3): number {
    if (a.length < n || b.length < n) return 0

    const toNgrams = (seq: string[]): Set<string> => {
      const ngrams = new Set<string>()
      for (let i = 0; i <= seq.length - n; i++) {
        ngrams.add(seq.slice(i, i + n).join("-"))
      }
      return ngrams
    }

    const setA = toNgrams(a)
    const setB = toNgrams(b)
    const intersection = [...setA].filter(x => setB.has(x)).length
    const union = new Set([...setA, ...setB]).size
    return union === 0 ? 0 : intersection / union
  }

  private getOrComputeFingerprint(filePath: string): string[] {
    if (this.structureCache.has(filePath)) {
      return this.structureCache.get(filePath)!
    }
    let source: string
    try {
      source = readFileSync(filePath, "utf-8")
    } catch {
      return []
    }
    const seq = this.getControlFlowSequence(source)
    this.structureCache.set(filePath, seq)
    return seq
  }

  private checkStructure(content: string, sourceFiles: string[]): Violation | null {
    const contentSeq = this.getControlFlowSequence(content)
    if (contentSeq.length < 3) return null // 太短，无法有效指纹

    for (const file of sourceFiles) {
      const fileSeq = this.getOrComputeFingerprint(file)
      if (fileSeq.length < 3) continue

      const sim = this.ngramSimilarity(fileSeq, contentSeq, 3)
      if (sim >= this.config.structureSimilarityThreshold) {
        return {
          type: "code_block_leak",
          detail: `控制流结构相似度 ${(sim * 100).toFixed(1)}% ≥ 阈值 ${(this.config.structureSimilarityThreshold * 100).toFixed(1)}% (${file})`,
          severity: "high",
        }
      }
    }
    return null
  }

  // ── Layer 3: Meta-Guard 语义审查 ─────────────────────────────

  private async checkMetaGuard(content: string): Promise<Violation | null> {
    const model = this.config.metaGuardModel!
    const prompt = buildMetaGuardPrompt(content)

    let response: string
    try {
      response = await callOpenAICompatible(
        model,
        prompt,
        this.config.metaGuardMaxTokens,
      )
    } catch {
      // Meta-Guard 调用失败时 fail-open（不阻断流程）
      return null
    }

    const upper = response.trim().toUpperCase()
    if (upper.startsWith("UNSAFE")) {
      const reason = response.replace(/^UNSAFE\s*/i, "").trim().slice(0, 50)
      return {
        type: "code_block_leak",
        detail: `Meta-Guard 判定为语义泄漏: ${reason || "包含可复现的实现逻辑"}`,
        severity: "high",
      }
    }
    return null
  }

  // ── 原有辅助方法 ──────────────────────────────────────────────

  private extractInternalTokens(secretFiles: string[]): Set<string> {
    const safeSet = new Set(this.config.knownSafeTokens)
    const internal = new Set<string>()

    for (const file of secretFiles) {
      let source: string
      try {
        source = readFileSync(file, "utf-8")
      } catch {
        continue
      }

      for (const token of extractIdentifiers(source, this.config.minTokenLength)) {
        if (safeSet.has(token)) continue
        if (this.publicTokens!.has(token)) continue
        if (isCommonWord(token)) continue
        internal.add(token)
      }
    }

    return internal
  }

  private loadPublicTokens(): Set<string> {
    const tokens = new Set<string>()
    for (const file of this.config.publicFiles) {
      let source: string
      try {
        source = readFileSync(file, "utf-8")
      } catch {
        continue
      }
      for (const token of extractIdentifiers(source, this.config.minTokenLength)) {
        tokens.add(token)
      }
    }
    return tokens
  }

  /** 仅供测试用，直接暴露结构相似度计算 */
  _testNgramSimilarity(a: string[], b: string[], n = 3): number {
    return this.ngramSimilarity(a, b, n)
  }

  _testGetControlFlowSequence(text: string): string[] {
    return this.getControlFlowSequence(text)
  }
}

// ===== Meta-Guard Prompt =====

function buildMetaGuardPrompt(content: string): string {
  return `You are a code security reviewer. Decide if the text below leaks reproducible implementation details (exact algorithm steps, internal data structures, specific conditions/thresholds that could reconstruct the source).

Reply with exactly: SAFE or UNSAFE, then a short reason (under 10 words).

Examples:
TEXT: "The function accepts a list of tokens and returns a sorted array based on their frequency scores."
ANSWER: SAFE - describes behavior only

TEXT: "The scheduler uses a priority queue. If queue size > 128, it flushes by iterating i=0..N and calling dispatch(items[i], 0x3F) with mask 0b00111111."
ANSWER: UNSAFE - contains internal thresholds and constants

TEXT: "Loads model weights from file. Validates header magic bytes. Allocates tensors based on layer count. Returns model handle."
ANSWER: SAFE - no reproducible logic

TEXT: "For each layer: compute attention scores = softmax(Q*K^T / sqrt(d_k)), apply dropout with p=0.1, multiply by V matrix."
ANSWER: UNSAFE - exact algorithm with parameters

TEXT:
${content.slice(0, 2000)}`
}

// ===== 辅助函数 =====

function extractIdentifiers(source: string, minLength: number): string[] {
  const regex = new RegExp(`\\b[A-Za-z_][A-Za-z0-9_]{${minLength - 1},}\\b`, "g")
  const matches = source.match(regex) || []
  return [...new Set(matches)].filter(
    (id) => /[_\d]/.test(id) || /[A-Z]/.test(id),
  )
}

function isBoilerplate(line: string): boolean {
  return /^(#include|import |from |using |require\(|\/\/|\/\*|\*|#pragma|#define|#ifndef|#endif)/.test(line)
}

const COMMON_WORDS = new Set([
  "function", "return", "export", "default", "undefined", "constructor",
  "prototype", "toString", "valueOf", "hasOwnProperty", "addEventListener",
  "removeEventListener", "createElement", "getElementById", "querySelector",
  "innerHTML", "textContent", "className", "setAttribute", "getAttribute",
  "console_log", "string_length", "array_push", "object_keys",
])

function isCommonWord(token: string): boolean {
  return COMMON_WORDS.has(token.toLowerCase())
}

/**
 * 尝试解码内容中的 base64/hex 编码块，返回附加了解码文本的字符串。
 * 用于防止攻击者用编码方式绕过 Token 泄漏检测。
 */
function decodeEncodedChunks(text: string): string {
  const extra: string[] = []

  // base64：长度 ≥ 20，以 =? 结尾
  const b64 = /[A-Za-z0-9+/]{20,}={0,2}/g
  let m: RegExpExecArray | null
  while ((m = b64.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(m[0], "base64").toString("utf-8")
      // 只收录可打印 ASCII（避免误报二进制数据）
      if (decoded.length > 5 && /^[\x20-\x7e\n\r\t]+$/.test(decoded)) {
        extra.push(decoded)
      }
    } catch { /* skip */ }
  }

  // hex：连续偶数个十六进制字符，至少 16 个（8 字节）
  const hex = /(?:[0-9a-fA-F]{2}){8,}/g
  while ((m = hex.exec(text)) !== null) {
    try {
      const decoded = Buffer.from(m[0], "hex").toString("utf-8")
      if (decoded.length > 4 && /^[\x20-\x7e\n\r\t]+$/.test(decoded)) {
        extra.push(decoded)
      }
    } catch { /* skip */ }
  }

  return extra.length > 0 ? text + "\n" + extra.join("\n") : text
}
