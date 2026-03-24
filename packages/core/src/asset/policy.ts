import { readFileSync, readdirSync } from "fs"
import { join } from "path"
import * as yaml from "js-yaml"
import picomatch from "picomatch"
import { relative } from "path"
import type {
  AssetLevel,
  TrustPolicy,
  PolicySettings,
  TrustConfig,
  ResolvedModels,
  SecurityConfig,
  RuntimeToolsConfig,
  SessionConfig,
  AuditConfig,
  LowTrustModelConfig,
  HighTrustModelConfig,
  ProjectionLevel,
} from "../types"

// ===== AssetMap =====

export type AssetMap = {
  getLevel(filePath: string): AssetLevel
  listFiles(level: AssetLevel): string[]
  getSettings(): PolicySettings
  readonly policy: TrustPolicy
}

// ===== 新格式 YAML 类型（内部，不导出）=====

type RawProvider = {
  api?: "anthropic" | "openai" | "openai-compatible"
  baseURL?: string
  apiKey?: string
  models?: Record<string, { contextWindow?: number; maxTokens?: number; timeoutMs?: number }>
}

type RawModelRef = {
  provider?: string
  model?: string
  maxTokens?: number
  timeoutMs?: number
  // 旧格式兼容：直接写 baseURL
  baseURL?: string
  apiKey?: string
}

type RawAssetRule = {
  pattern: string
  level: AssetLevel
  reason?: string
}

type RawTrustConfig = {
  // 格式版本
  version?: string

  // ── 新格式 ──────────────────────────────────────────────────
  assets?: {
    default?: AssetLevel
    rules?: RawAssetRule[]
    ignore?: string[]
    // 旧格式兼容
    secret?: string[]
    derived?: string[]
  }
  providers?: Record<string, RawProvider>
  models?: {
    driver?: RawModelRef
    projector?: RawModelRef
    answerer?: RawModelRef
    patcher?: RawModelRef
    meta_guard?: RawModelRef
  }
  security?: {
    projection?: {
      default_level?: number
      max_level?: number
      budget?: { tokens_per_file?: number; ask_limit?: number }
      prompts?: { l2?: string; l3?: string }
    }
    guard?: {
      token_match?: {
        enabled?: boolean
        min_token_length?: number
        min_line_length?: number
        known_safe_tokens?: string[]
      }
      structure_fingerprint?: {
        enabled?: boolean
        similarity_threshold?: number
      }
      meta_guard?: {
        enabled?: boolean
        max_tokens?: number
      }
      canary?: { auto_plant?: boolean }
    }
  }
  tools?: {
    allowed?: string[]
    bash?: {
      policy?: "workspace_isolated" | "unrestricted" | "disabled"
      build_commands_pass_through?: boolean
    }
    grep?: { exclude_dirs?: string[] }
  }
  session?: {
    max_iterations?: number
    workspace?: { enabled?: boolean; mode?: "symlink" | "copy" }
    atomic_writes?: boolean
  }
  audit?: {
    enabled?: boolean
    log_dir?: string
    retention_days?: number
  }

  // ── 旧格式兼容（flat 根级字段）──────────────────────────────
  default?: AssetLevel
  secret?: string[]
  derived?: string[]
  ignore?: string[]
  settings?: {
    default_projection_level?: number
    max_projection_level?: number
    info_budget_ceiling?: number
    ask_limit?: number
    known_safe_tokens?: string[]
    low_trust_model?: RawModelRef & { provider?: string }
    high_trust_models?: {
      projector?: RawModelRef
      answerer?: RawModelRef
      patcher?: RawModelRef
    }
    guard?: {
      structure_similarity_threshold?: number
      meta_guard_enabled?: boolean
      meta_guard_max_tokens?: number
    }
  }
}

// ===== 主入口：新格式 =====

/**
 * 加载并解析 .trust-policy.yml，返回完整运行时配置。
 * 同时支持新格式（providers/models/security 分层）和旧格式（flat settings）。
 */
export function loadTrustConfig(policyPath: string, projectRoot: string): TrustConfig {
  const raw = readFileSync(policyPath, "utf-8")
  const doc = yaml.load(raw) as RawTrustConfig

  const isNewFormat = !!(doc.assets || doc.providers || doc.models || doc.security)

  const assetRules = isNewFormat
    ? parseNewAssetRules(doc)
    : parseLegacyAssetRules(doc)

  const defaultLevel: AssetLevel = isNewFormat
    ? (doc.assets?.default ?? "public")
    : ((doc.default as AssetLevel) ?? "public")

  const models = resolveModels(doc, isNewFormat)
  const security = resolveSecurityConfig(doc, isNewFormat)
  const tools = resolveToolsConfig(doc)
  const session = resolveSessionConfig(doc)
  const audit = resolveAuditConfig(doc)

  // 构建 AssetMap（兼容旧 Gate/Budget 接口）
  const legacySettings = buildLegacySettings(models, security)
  const assetMap = buildAssetMap(assetRules, defaultLevel, projectRoot, legacySettings)

  return { assetMap, models, security, tools, session, audit }
}

// ===== 旧格式兼容 API =====

const DEFAULT_SETTINGS: PolicySettings = {
  default_projection_level: 2,
  max_projection_level: 3,
  info_budget_ceiling: 4096,
  ask_limit: 20,
  known_safe_tokens: [],
}

export function loadPolicy(policyPath: string): TrustPolicy {
  const raw = readFileSync(policyPath, "utf-8")
  const doc = yaml.load(raw) as Record<string, unknown>
  const s = (doc.settings || {}) as Partial<PolicySettings>
  return {
    default: (doc.default as AssetLevel) || "public",
    secret: asStringArray(doc.secret),
    derived: asStringArray(doc.derived),
    ignore: asStringArray(doc.ignore),
    settings: { ...DEFAULT_SETTINGS, ...s },
  }
}

export function createAssetMap(policy: TrustPolicy, projectRoot: string): AssetMap {
  const rules: { pattern: string; level: AssetLevel; ignore: boolean }[] = []
  for (const p of policy.ignore) rules.push({ pattern: p, level: "public", ignore: true })
  for (const p of policy.secret) rules.push({ pattern: p, level: "secret", ignore: false })
  for (const p of policy.derived) rules.push({ pattern: p, level: "derived", ignore: false })
  return buildAssetMap(rules, policy.default, projectRoot, policy.settings)
}

// ===== 解析辅助 =====

function parseNewAssetRules(doc: RawTrustConfig) {
  const rules: { pattern: string; level: AssetLevel; ignore: boolean }[] = []
  const ignore = doc.assets?.ignore ?? []
  for (const p of ignore) {
    rules.push({ pattern: p, level: "public", ignore: true })
  }
  for (const rule of doc.assets?.rules ?? []) {
    rules.push({ pattern: rule.pattern, level: rule.level, ignore: false })
  }
  // 旧格式字段也可能出现在 assets 里
  for (const p of doc.assets?.secret ?? []) {
    rules.push({ pattern: p, level: "secret", ignore: false })
  }
  for (const p of doc.assets?.derived ?? []) {
    rules.push({ pattern: p, level: "derived", ignore: false })
  }
  return rules
}

function parseLegacyAssetRules(doc: RawTrustConfig) {
  const rules: { pattern: string; level: AssetLevel; ignore: boolean }[] = []
  for (const p of asStringArray(doc.ignore)) {
    rules.push({ pattern: p, level: "public", ignore: true })
  }
  for (const p of asStringArray(doc.secret)) {
    rules.push({ pattern: p, level: "secret", ignore: false })
  }
  for (const p of asStringArray(doc.derived)) {
    rules.push({ pattern: p, level: "derived", ignore: false })
  }
  return rules
}

function resolveModels(doc: RawTrustConfig, isNewFormat: boolean): ResolvedModels {
  const providers = doc.providers ?? {}

  function resolveHighTrust(ref: RawModelRef | undefined): HighTrustModelConfig | undefined {
    if (!ref) return undefined
    // 新格式：provider 引用
    if (ref.provider && providers[ref.provider]) {
      const p = providers[ref.provider]
      return {
        baseURL: p.baseURL ?? "http://localhost:11434/v1",
        model: ref.model ?? "",
        apiKey: resolveEnvVar(ref.apiKey ?? p.apiKey),
        timeoutMs: ref.timeoutMs,
        maxTokens: ref.maxTokens ?? p.models?.[ref.model ?? ""]?.maxTokens,
      }
    }
    // 直接字段（旧格式兼容）
    if (ref.baseURL) {
      return {
        baseURL: ref.baseURL,
        model: ref.model ?? "",
        apiKey: resolveEnvVar(ref.apiKey),
        timeoutMs: ref.timeoutMs,
        maxTokens: ref.maxTokens,
      }
    }
    return undefined
  }

  function resolveLowTrust(ref: RawModelRef | undefined): LowTrustModelConfig {
    if (!ref) {
      return { provider: "anthropic", model: "claude-sonnet-4-20250514" }
    }
    // 新格式：provider 引用
    if (ref.provider && providers[ref.provider]) {
      const p = providers[ref.provider]
      const api = p.api ?? "openai-compatible"
      return {
        provider: api === "anthropic" ? "anthropic" : api === "openai" ? "openai" : "openai-compatible",
        model: ref.model ?? "",
        apiKey: resolveEnvVar(ref.apiKey ?? p.apiKey),
        baseURL: p.baseURL,
      }
    }
    // 直接字段（旧格式兼容）
    return {
      provider: (ref.provider as LowTrustModelConfig["provider"]) ?? "anthropic",
      model: ref.model ?? "claude-sonnet-4-20250514",
      apiKey: resolveEnvVar(ref.apiKey),
      baseURL: ref.baseURL,
    }
  }

  if (isNewFormat) {
    const m = doc.models ?? {}
    const answerer = resolveHighTrust(m.answerer)
    return {
      driver: resolveLowTrust(m.driver),
      projector: resolveHighTrust(m.projector),
      answerer,
      patcher: resolveHighTrust(m.patcher),
      meta_guard: resolveHighTrust(m.meta_guard) ?? answerer,
    }
  }

  // 旧格式
  const s = doc.settings ?? {}
  const htModels = s.high_trust_models ?? {}
  const answerer = resolveHighTrust(htModels.answerer)
  return {
    driver: resolveLowTrust(s.low_trust_model as RawModelRef | undefined),
    projector: resolveHighTrust(htModels.projector),
    answerer,
    patcher: resolveHighTrust(htModels.patcher),
    meta_guard: answerer,
  }
}

function resolveSecurityConfig(doc: RawTrustConfig, isNewFormat: boolean): SecurityConfig {
  if (isNewFormat) {
    const sec = doc.security ?? {}
    const proj = sec.projection ?? {}
    const g = sec.guard ?? {}
    return {
      projection: {
        default_level: (proj.default_level ?? 2) as ProjectionLevel,
        max_level: (proj.max_level ?? 3) as ProjectionLevel,
        budget: {
          tokens_per_file: proj.budget?.tokens_per_file ?? 4096,
          ask_limit: proj.budget?.ask_limit ?? 20,
        },
        prompts: {
          l2: proj.prompts?.l2,
          l3: proj.prompts?.l3,
        },
      },
      guard: {
        token_match: {
          enabled: g.token_match?.enabled ?? true,
          min_token_length: g.token_match?.min_token_length ?? 7,
          min_line_length: g.token_match?.min_line_length ?? 24,
          known_safe_tokens: g.token_match?.known_safe_tokens ?? [],
        },
        structure_fingerprint: {
          enabled: g.structure_fingerprint?.enabled ?? true,
          similarity_threshold: g.structure_fingerprint?.similarity_threshold ?? 0.75,
        },
        meta_guard: {
          enabled: g.meta_guard?.enabled ?? true,
          max_tokens: g.meta_guard?.max_tokens ?? 20,
        },
        canary: {
          auto_plant: g.canary?.auto_plant ?? false,
        },
      },
    }
  }

  // 旧格式
  const s = doc.settings ?? {}
  const g = s.guard ?? {}
  return {
    projection: {
      default_level: (s.default_projection_level ?? 2) as ProjectionLevel,
      max_level: (s.max_projection_level ?? 3) as ProjectionLevel,
      budget: {
        tokens_per_file: s.info_budget_ceiling ?? 4096,
        ask_limit: s.ask_limit ?? 20,
      },
      prompts: {},
    },
    guard: {
      token_match: {
        enabled: true,
        min_token_length: 7,
        min_line_length: 24,
        known_safe_tokens: s.known_safe_tokens ?? [],
      },
      structure_fingerprint: {
        enabled: true,
        similarity_threshold: g.structure_similarity_threshold ?? 0.75,
      },
      meta_guard: {
        enabled: g.meta_guard_enabled ?? true,
        max_tokens: g.meta_guard_max_tokens ?? 20,
      },
      canary: { auto_plant: false },
    },
  }
}

function resolveToolsConfig(doc: RawTrustConfig): RuntimeToolsConfig {
  const t = doc.tools ?? {}
  return {
    allowed: t.allowed ?? ["read", "edit", "write", "grep", "glob", "bash", "ask_high_trust"],
    bash: {
      policy: t.bash?.policy ?? "workspace_isolated",
      build_commands_pass_through: t.bash?.build_commands_pass_through ?? true,
    },
    grep: {
      exclude_dirs: t.grep?.exclude_dirs ?? ["node_modules", ".git", "dist", ".trust-proxy"],
    },
  }
}

function resolveSessionConfig(doc: RawTrustConfig): SessionConfig {
  const s = doc.session ?? {}
  return {
    max_iterations: s.max_iterations ?? 50,
    workspace: {
      enabled: s.workspace?.enabled ?? false,
      mode: s.workspace?.mode ?? "symlink",
    },
    atomic_writes: s.atomic_writes ?? false,
  }
}

function resolveAuditConfig(doc: RawTrustConfig): AuditConfig {
  const a = doc.audit ?? {}
  return {
    enabled: a.enabled ?? true,
    log_dir: a.log_dir ?? ".trust-proxy/audit",
    retention_days: a.retention_days ?? 30,
  }
}

/** 将新格式 TrustConfig 映射回旧 PolicySettings，供 Gate/Budget 使用 */
function buildLegacySettings(models: ResolvedModels, security: SecurityConfig): PolicySettings {
  return {
    default_projection_level: security.projection.default_level,
    max_projection_level: security.projection.max_level,
    info_budget_ceiling: security.projection.budget.tokens_per_file,
    ask_limit: security.projection.budget.ask_limit,
    known_safe_tokens: security.guard.token_match.known_safe_tokens,
    low_trust_model: models.driver,
    high_trust_models: {
      projector: models.projector,
      answerer: models.answerer,
      patcher: models.patcher,
    },
    guard: {
      structure_similarity_threshold: security.guard.structure_fingerprint.similarity_threshold,
      meta_guard_enabled: security.guard.meta_guard.enabled,
      meta_guard_max_tokens: security.guard.meta_guard.max_tokens,
    },
  }
}

function buildAssetMap(
  rules: { pattern: string; level: AssetLevel; ignore: boolean }[],
  defaultLevel: AssetLevel,
  projectRoot: string,
  settings: PolicySettings,
): AssetMap {
  // 构建匹配器（优先级：ignore > secret > derived）
  const ignorePatterns = rules.filter(r => r.ignore).map(r => r.pattern).filter(isValidGlob)
  const secretPatterns = rules.filter(r => !r.ignore && r.level === "secret").map(r => r.pattern).filter(isValidGlob)
  const derivedPatterns = rules.filter(r => !r.ignore && r.level === "derived").map(r => r.pattern).filter(isValidGlob)

  const ignoreMatch = ignorePatterns.length > 0 ? picomatch(ignorePatterns) : () => false
  const secretMatch = secretPatterns.length > 0 ? picomatch(secretPatterns) : () => false
  const derivedMatch = derivedPatterns.length > 0 ? picomatch(derivedPatterns) : () => false

  // 构建兼容旧 TrustPolicy 的 policy 对象
  const policy: TrustPolicy = {
    default: defaultLevel,
    secret: secretPatterns,
    derived: derivedPatterns,
    ignore: ignorePatterns,
    settings,
  }

  return {
    policy,
    getLevel(filePath: string): AssetLevel {
      const rel = toRelative(projectRoot, filePath)
      if (ignoreMatch(rel)) return "public"
      if (secretMatch(rel)) return "secret"
      if (derivedMatch(rel)) return "derived"
      return defaultLevel
    },
    listFiles(level: AssetLevel): string[] {
      const matcher =
        level === "secret" ? secretMatch :
        level === "derived" ? derivedMatch :
        null
      if (!matcher) return []
      const results: string[] = []
      const scan = (dir: string) => {
        try {
          for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue
            const full = join(dir, entry.name)
            if (entry.isDirectory()) {
              scan(full)
            } else {
              const rel = toRelative(projectRoot, full)
              if (!ignoreMatch(rel) && matcher(rel)) results.push(full)
            }
          }
        } catch { /* skip permission errors */ }
      }
      scan(projectRoot)
      return results.slice(0, 50) // cap at 50 files
    },
    getSettings(): PolicySettings {
      return settings
    },
  }
}

// ===== 工具函数 =====

/**
 * 解析环境变量插值，如 ${ANTHROPIC_API_KEY}
 */
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "")
}

function toRelative(root: string, filePath: string): string {
  if (filePath.startsWith("/")) {
    return relative(root, filePath).replaceAll("\\", "/")
  }
  return filePath.replaceAll("\\", "/")
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
  return []
}

/** 过滤掉注释行（YAML 里写的 # 开头的字符串当注释用） */
function isValidGlob(pattern: string): boolean {
  return !pattern.startsWith("#")
}
