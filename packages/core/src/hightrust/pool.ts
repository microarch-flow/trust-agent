import type {
  HighTrustModelConfig,
  HighTrustPoolConfig,
  HighTrustTask,
  HighTrustResult,
  ProjectionLevel,
  ProjectionResult,
} from "../types"
import type { GuardInput } from "../guard/guard"
import type { Guard } from "../guard/guard"
import type { AuditLogger } from "../audit/logger"
import { basename } from "path"
import { callOpenAICompatible } from "./api"

/**
 * 高信任模型池
 *
 * 通过 OpenAI-compatible API 调用本地部署的模型。
 * 不绑定特定推理框架（Ollama、vLLM、LMStudio、SGLang 等均可）。
 */
export class HighTrustPool {
  private config: HighTrustPoolConfig
  private guard: Guard
  private auditLogger: AuditLogger
  private sessionId: string

  constructor(
    config: HighTrustPoolConfig,
    guard: Guard,
    auditLogger: AuditLogger,
    sessionId: string,
  ) {
    this.config = config
    this.guard = guard
    this.auditLogger = auditLogger
    this.sessionId = sessionId
  }

  async dispatch(task: HighTrustTask): Promise<HighTrustResult> {
    switch (task.type) {
      case "project":
        return this.handleProjection(task.file, task.level)
      case "answer":
        return this.handleAnswer(task.question, task.files, task.context)
      case "patch":
        return this.handlePatch(task.file, task.intent, task.context)
    }
  }

  // ===== Projector =====

  private async handleProjection(filePath: string, level: ProjectionLevel): Promise<HighTrustResult> {
    const modelConfig = this.config.projector
    if (!modelConfig) {
      return {
        type: "projection",
        result: this.fallbackProjection(filePath, level),
      }
    }

    const { readFileSync } = await import("fs")
    const source = readFileSync(filePath, "utf-8")
    const start = Date.now()

    const prompt = buildProjectionPrompt(source, filePath, level, this.config.prompts)
    const content = await callOpenAICompatible(modelConfig, prompt)

    this.auditLogger.logHighTrustCall(
      this.sessionId,
      modelConfig.model,
      filePath,
      Date.now() - start,
    )

    // Guard 检查
    const guardResult = await this.guard.check({
      content,
      sourceFiles: [filePath],
      contentType: "projection",
    })

    if (!guardResult.passed && level > 0) {
      // 降级重试
      return this.handleProjection(filePath, (level - 1) as ProjectionLevel)
    }

    const result: ProjectionResult = {
      content: `[PROJECTED L${level}] ${basename(filePath)}\n\n${content}`,
      level,
      format: level >= 2 ? "json" : "text",
      tokenCount: estimateTokens(content),
      sourceHash: "",
      generatedAt: new Date().toISOString(),
      generatedBy: "model",
    }

    return { type: "projection", result }
  }

  // ===== Answerer =====

  private async handleAnswer(
    question: string,
    files: string[],
    context?: string,
  ): Promise<HighTrustResult> {
    const modelConfig = this.config.answerer
    if (!modelConfig) {
      return {
        type: "answer",
        text: "[HIGH_TRUST] answerer 模型未配置。请在 .trust-policy.yml 的 settings.high_trust_models.answerer 中配置。",
        guardPassed: true,
      }
    }

    const { readFileSync } = await import("fs")
    const sources: string[] = []
    for (const f of files) {
      try {
        sources.push(`=== ${f} ===\n${readFileSync(f, "utf-8")}`)
      } catch {
        sources.push(`=== ${f} ===\n[文件不可读]`)
      }
    }

    const start = Date.now()
    const prompt = buildAnswerPrompt(question, sources.join("\n\n"), context)
    const answer = await callOpenAICompatible(modelConfig, prompt)

    this.auditLogger.logHighTrustCall(
      this.sessionId,
      modelConfig.model,
      files[0] || "unknown",
      Date.now() - start,
    )

    // Guard 检查回答中是否泄露源码
    const guardResult = await this.guard.check({
      content: answer,
      sourceFiles: files,
      contentType: "answer",
    })

    return {
      type: "answer",
      text: guardResult.passed
        ? answer
        : `[GUARD BLOCKED] 回答中检测到潜在代码泄露，已拦截。请尝试更具体的问题。`,
      guardPassed: guardResult.passed,
    }
  }

  // ===== Patcher (Phase 3) =====

  private async handlePatch(
    filePath: string,
    intent: string,
    context?: string,
  ): Promise<HighTrustResult> {
    const modelConfig = this.config.patcher
    if (!modelConfig) {
      return {
        type: "patch",
        diff: "",
        guardPassed: false,
        linesChanged: 0,
      }
    }

    const { readFileSync } = await import("fs")
    let source: string
    try {
      source = readFileSync(filePath, "utf-8")
    } catch {
      return {
        type: "patch",
        diff: `[ERROR] 无法读取文件: ${filePath}`,
        guardPassed: false,
        linesChanged: 0,
      }
    }

    const start = Date.now()
    const prompt = buildPatchPrompt(source, filePath, intent, context)
    const diff = await callOpenAICompatible(modelConfig, prompt)

    this.auditLogger.logHighTrustCall(
      this.sessionId,
      modelConfig.model,
      filePath,
      Date.now() - start,
    )

    // Guard 检查 diff（这里检查的是 diff 回传给 low-trust LLM 时是否安全）
    const guardResult = await this.guard.check({
      content: diff,
      sourceFiles: [filePath],
      contentType: "patch_diff",
    })

    return {
      type: "patch",
      diff: guardResult.passed ? diff : "[GUARD BLOCKED] diff 包含敏感信息",
      guardPassed: guardResult.passed,
      linesChanged: diff.split("\n").filter(l => l.startsWith("+") || l.startsWith("-")).length,
    }
  }

  // ===== Fallback =====

  private fallbackProjection(filePath: string, _level: ProjectionLevel): ProjectionResult {
    return {
      content: `[PROJECTED L0] ${basename(filePath)}\n[模型未配置，仅返回 L0 信息]`,
      level: 0,
      format: "text",
      tokenCount: 20,
      sourceHash: "",
      generatedAt: new Date().toISOString(),
      generatedBy: "stat",
    }
  }

  hasProjector(): boolean {
    return !!this.config.projector
  }

  hasAnswerer(): boolean {
    return !!this.config.answerer
  }

  hasPatcher(): boolean {
    return !!this.config.patcher
  }
}

// ===== OpenAI-compatible API 调用（委托给共享工具）=====

export { callOpenAICompatible } from "./api"

// ===== Prompt 构建 =====

export function buildProjectionPrompt(
  source: string,
  filePath: string,
  level: ProjectionLevel,
  customPrompts?: { l2?: string; l3?: string },
): string {
  const fileName = basename(filePath)
  // 限制传入模型的源码长度，避免小模型 context 溢出
  const truncated = source.length > 12000 ? source.slice(0, 12000) + "\n...[truncated]" : source

  const base = `You are a code analysis assistant. Analyze the following source file and generate a projection.

File: ${fileName}

STRICT RULES - MUST FOLLOW:
- NEVER copy source code lines directly
- Describe structure and behavior in your own words
- Do NOT output constant values, keys, weights, or algorithm parameters
- Output only the projection content, no extra explanation

Source code:
\`\`\`
${truncated}
\`\`\`
`

  switch (level) {
    case 2: {
      const l2Template = customPrompts?.l2 ?? `Generate a Level 2 projection (behavior summary). Use this exact format:

## Purpose
One or two sentences describing what this file does.

## Exports
For each exported function/class/type, one line:
- FunctionName(params) → return type: what it does in plain English

## Dependencies
Comma-separated list of key imported modules/headers.

Keep the entire output under 300 words. Do not include any source code.`
      return `${base}\n${l2Template}`
    }

    case 3: {
      const l3Template = customPrompts?.l3 ?? `Generate a Level 3 projection (pseudocode). Use this exact format:

## Purpose
One sentence.

## Pseudocode
For each function, write natural-language pseudocode:

FUNCTION functionName(params):
  describe what it does step by step
  IF some condition: describe branch
  FOR each item: describe loop body
  RETURN describe what is returned
  [REDACTED] for any constants, magic values, or algorithm parameters

Rules:
- Keep control flow keywords (IF/FOR/WHILE/RETURN) but replace conditions with descriptions
- Replace ALL literals, constants, thresholds with [REDACTED]
- No actual source code lines
- Under 500 words total`
      return `${base}\n${l3Template}`
    }

    default:
      return `${base}
Generate a brief summary:
1. File purpose (one sentence)
2. List of exported functions/classes/types
3. No source code`
  }
}

function buildAnswerPrompt(question: string, sources: string, context?: string): string {
  return `你是一个代码分析助手。根据提供的源代码回答问题。

重要规则:
- 用自然语言回答，不要直接引用源码
- 可以描述函数行为、参数类型、返回值，但不要复制代码行
- 如果涉及常量/密钥/算法参数，用描述性语言替代具体值

源代码:
${sources}

${context ? `背景: ${context}\n` : ""}
问题: ${question}

请用中文回答:`
}

function buildPatchPrompt(source: string, filePath: string, intent: string, context?: string): string {
  return `你是一个代码修改助手。根据修改意图生成 unified diff。

文件: ${filePath}
${context ? `背景: ${context}\n` : ""}
修改意图: ${intent}

当前源码:
\`\`\`
${source}
\`\`\`

请生成 unified diff 格式的修改:
- 只输出 diff，不要解释
- 确保 diff 可以直接 apply`
}

// ===== 辅助 =====

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
