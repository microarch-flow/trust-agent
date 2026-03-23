// ===== 敏感级别 =====

export type AssetLevel = "secret" | "derived" | "public"

// ===== Projection =====

export type ProjectionLevel = 0 | 1 | 2 | 3

export type ProjectionResult = {
  content: string
  level: ProjectionLevel
  format: "text" | "json"
  tokenCount: number
  sourceHash: string
  generatedAt: string
  generatedBy: "stat" | "treesitter" | "model"
}

// ===== Trust Gate =====

export type GateVerdict =
  | { action: "PASS" }
  | { action: "PROXY_READ"; file: string; level: ProjectionLevel }
  | { action: "PROXY_WRITE"; file: string; intent: string }
  | { action: "REDACT"; redactions: Redaction[] }
  | { action: "DENY"; reason: string }

export type Redaction = {
  file: string
  matches: number
}

// ===== Guard =====

export type GuardResult = {
  passed: boolean
  violations: Violation[]
  checkedAt: string
  durationMs: number
}

export type Violation = {
  type: "token_leak" | "line_leak" | "code_block_leak" | "schema_invalid"
  detail: string
  severity: "high" | "medium" | "low"
}

// ===== High-Trust =====

export type HighTrustTask =
  | { type: "project"; file: string; level: ProjectionLevel }
  | { type: "answer"; question: string; files: string[]; context?: string }
  | { type: "patch"; file: string; intent: string; context?: string }

export type HighTrustResult =
  | { type: "projection"; result: ProjectionResult }
  | { type: "answer"; text: string; guardPassed: boolean }
  | { type: "patch"; diff: string; guardPassed: boolean; linesChanged: number }

// ===== Tool =====

export type ToolResult = {
  output: string
  metadata?: Record<string, unknown>
}

export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
}

// ===== Audit =====

export type AuditEvent =
  | GateAuditEvent
  | ProjectionAuditEvent
  | GuardAuditEvent
  | HighTrustCallEvent

export type GateAuditEvent = {
  type: "gate"
  timestamp: string
  sessionId: string
  toolName: string
  filePath?: string
  verdict: string
  reason?: string
  durationMs: number
}

export type ProjectionAuditEvent = {
  type: "projection"
  timestamp: string
  sessionId: string
  filePath: string
  level: ProjectionLevel
  tokenCount: number
  source: "cache" | "stat" | "treesitter" | "model"
  guardPassed: boolean
}

export type GuardAuditEvent = {
  type: "guard"
  timestamp: string
  sessionId: string
  contentType: string
  passed: boolean
  violationCount: number
}

export type HighTrustCallEvent = {
  type: "hightrust_call"
  timestamp: string
  sessionId: string
  model: string
  filePath: string
  durationMs: number
}

// ===== Model Config =====

/**
 * 低信任模型配置（云端 LLM，驱动编码任务）
 */
export type LowTrustModelConfig = {
  provider: "openai" | "anthropic" | "openai-compatible"
  model: string
  apiKey?: string
  baseURL?: string
}

/**
 * 高信任模型配置（本地模型，处理 secret 文件）
 */
export type HighTrustModelConfig = {
  baseURL: string
  model: string
  apiKey?: string
  timeoutMs?: number
  maxTokens?: number
}

export type HighTrustPoolConfig = {
  projector?: HighTrustModelConfig
  answerer?: HighTrustModelConfig
  patcher?: HighTrustModelConfig
  /** 外置投影 prompt（覆盖内建） */
  prompts?: { l2?: string; l3?: string }
}

// ===== New: Resolved Model Roles =====

/**
 * 按角色分配的已解析模型配置（由 loadTrustConfig 返回）
 */
export type ResolvedModels = {
  /** 云端驱动模型（低信任） */
  driver: LowTrustModelConfig
  /** L2/L3 投影生成 */
  projector?: HighTrustModelConfig
  /** ask_high_trust 问题回答 */
  answerer?: HighTrustModelConfig
  /** secret 文件修改 */
  patcher?: HighTrustModelConfig
  /** Meta-Guard 语义审查（默认继承 answerer） */
  meta_guard?: HighTrustModelConfig
}

// ===== New: Runtime Config Sections =====

export type SecurityConfig = {
  projection: {
    default_level: ProjectionLevel
    max_level: ProjectionLevel
    budget: {
      tokens_per_file: number
      ask_limit: number
    }
    /** 外置 Prompt（可在 .trust-policy.yml 中覆盖内建提示词） */
    prompts: {
      l2?: string
      l3?: string
    }
  }
  guard: {
    token_match: {
      enabled: boolean
      min_token_length: number
      min_line_length: number
      known_safe_tokens: string[]
    }
    structure_fingerprint: {
      enabled: boolean
      similarity_threshold: number
    }
    meta_guard: {
      enabled: boolean
      max_tokens: number
    }
    canary: {
      auto_plant: boolean
    }
  }
}

export type RuntimeToolsConfig = {
  allowed: string[]
  bash: {
    policy: "workspace_isolated" | "unrestricted" | "disabled"
    build_commands_pass_through: boolean
  }
  grep: {
    exclude_dirs: string[]
  }
}

export type SessionConfig = {
  max_iterations: number
  workspace: {
    enabled: boolean
    mode: "symlink" | "copy"
  }
  /** 原子写入：缓冲所有 PROXY_WRITE，等待 flush_pending_writes 批量执行 */
  atomic_writes?: boolean
}

export type AuditConfig = {
  enabled: boolean
  log_dir: string
  retention_days: number
}

// ===== New: TrustConfig (primary return type of loadTrustConfig) =====

import type { AssetMap } from "./asset/policy"

export type TrustConfig = {
  /** 文件分类 map，用于 Gate/Budget */
  assetMap: AssetMap
  /** 按角色分配的已解析模型 */
  models: ResolvedModels
  /** 安全配置（投影、Guard 三层） */
  security: SecurityConfig
  /** 工具配置 */
  tools: RuntimeToolsConfig
  /** 会话配置 */
  session: SessionConfig
  /** 审计日志配置 */
  audit: AuditConfig
}

// ===== Legacy Policy Types (kept for backward compat with tests) =====

export type TrustPolicy = {
  default: AssetLevel
  secret: string[]
  derived: string[]
  ignore: string[]
  settings: PolicySettings
}

export type PolicySettings = {
  default_projection_level: ProjectionLevel
  max_projection_level: ProjectionLevel
  info_budget_ceiling: number
  ask_limit: number
  known_safe_tokens: string[]
  low_trust_model?: LowTrustModelConfig
  high_trust_models?: HighTrustPoolConfig
  guard?: GuardSecurityConfig
}

export type GuardSecurityConfig = {
  structure_similarity_threshold?: number
  meta_guard_enabled?: boolean
  meta_guard_max_tokens?: number
}

// ===== Session =====

export type Session = {
  id: string
  taskDescription: string
  projectRoot: string
  startedAt: string
  status: "running" | "completed" | "failed"
}
