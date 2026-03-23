// ===== Types =====
export type {
  AssetLevel,
  ProjectionLevel,
  ProjectionResult,
  GateVerdict,
  Redaction,
  GuardResult,
  Violation,
  HighTrustTask,
  HighTrustResult,
  ToolResult,
  ToolDefinition,
  AuditEvent,
  GateAuditEvent,
  ProjectionAuditEvent,
  GuardAuditEvent,
  HighTrustCallEvent,
  TrustPolicy,
  PolicySettings,
  LowTrustModelConfig,
  HighTrustModelConfig,
  HighTrustPoolConfig,
  GuardSecurityConfig,
  // New config types
  TrustConfig,
  ResolvedModels,
  SecurityConfig,
  RuntimeToolsConfig,
  SessionConfig,
  AuditConfig,
  Session,
} from "./types"

// ===== Asset Map =====
export { loadTrustConfig, loadPolicy, createAssetMap } from "./asset/policy"
export type { AssetMap } from "./asset/policy"

// ===== Projection =====
export { ProjectionEngine } from "./projection/engine"
export type { ProjectionRequest, ModelProjector } from "./projection/engine"
export { ProjectionCache } from "./projection/cache"
export type { CacheEntry, CacheStats } from "./projection/cache"

// ===== Guard =====
export { Guard } from "./guard/guard"
export type { GuardInput, GuardConfig } from "./guard/guard"
export { CanaryTester } from "./guard/canary"
export type { CanaryToken, CanaryResult } from "./guard/canary"

// ===== Trust Gate =====
export { TrustGate } from "./gate/gate"
export type { GateConfig } from "./gate/gate"
export { InfoBudgetTracker } from "./gate/budget"

// ===== Audit =====
export { AuditLogger } from "./audit/logger"
export type { AuditVerifyResult } from "./audit/logger"

// ===== Security Utilities =====
export { hasPromptInjection, hasIntentInjection } from "./guard/injection"

// ===== High-Trust Pool =====
export { HighTrustPool } from "./hightrust/pool"
export { Patcher } from "./hightrust/patcher"
export type { PatchRequest, PatchResult } from "./hightrust/patcher"

// ===== Workspace =====
export { WorkspaceManager } from "./workspace/manager"
export type { WorkspaceInfo } from "./workspace/manager"

// ===== Orchestrator =====
export { Orchestrator } from "./orchestrator/orchestrator"
export type { OrchestratorConfig, RunResult, LLMModel } from "./orchestrator/orchestrator"
export { createBuiltinTools } from "./orchestrator/tools"
