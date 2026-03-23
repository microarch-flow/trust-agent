# .trust-policy.yml Configuration Reference

All fields are optional unless marked **required**.

---

## Top-level structure

```yaml
version: "1"          # config format version (recommended)

assets: ...           # which files are secret / public / derived
providers: ...        # API provider definitions
models: ...           # model role assignments
security: ...         # projection, guard, canary settings
tools: ...            # tool allow-list and bash policy
session: ...          # iteration limits, workspace isolation, atomic writes
audit: ...            # audit log settings
```

---

## `assets`

Controls which files the agent can read directly vs. via projection.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default` | `"public" \| "secret" \| "derived"` | `"public"` | Level for files that match no rule |
| `rules` | list | `[]` | Ordered list of `{ pattern, level }` rules |
| `ignore` | list of globs | `[]` | Files to exclude from all classification |
| `secret` | list of globs | `[]` | *(legacy)* Secret file patterns |
| `derived` | list of globs | `[]` | *(legacy)* Derived (model-generated) file patterns |

Rules are checked in order; first match wins.

```yaml
assets:
  default: public
  rules:
    - pattern: "src/core/**"
      level: secret
    - pattern: "src/core/public_api.ts"
      level: public        # overrides the rule above for this file
  ignore:
    - "**/*.test.*"
    - "node_modules/**"
```

Asset levels:
- **`public`** — agent reads the file directly (PASS)
- **`secret`** — agent receives a projection instead of raw content (PROXY_READ)
- **`derived`** — like secret, but the file is model-generated (treated as secret)

---

## `providers`

Named API provider definitions. Referenced by models.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `api` | `"anthropic" \| "openai" \| "openai-compatible"` | `"openai-compatible"` | API protocol |
| `baseURL` | string | — | API base URL |
| `apiKey` | string | — | API key (supports `${ENV_VAR}` interpolation) |

```yaml
providers:
  cloud:
    api: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
  local:
    api: openai-compatible
    baseURL: http://localhost:11434/v1
```

---

## `models`

Assigns LLM roles. All model refs support `provider`, `model`, `maxTokens`, `timeoutMs`.

| Role | Purpose | Default |
|------|---------|---------|
| `driver` | Low-trust coding LLM (receives projections, not raw secrets) | Claude Sonnet |
| `projector` | Generates L2/L3 semantic projections locally | unset (L1 only) |
| `answerer` | Answers `ask_high_trust` questions in the secure domain | unset |
| `patcher` | Applies approved edits in the secure workspace | unset |
| `meta_guard` | Verifies projections don't leak secrets | falls back to `answerer` |

```yaml
models:
  driver:
    provider: cloud
    model: claude-sonnet-4-20250514
  projector:
    provider: local
    model: llama3.2
    maxTokens: 2048
    timeoutMs: 30000
  answerer:
    provider: local
    model: llama3.2
```

---

## `security`

### `security.projection`

Controls how secret files are summarized for the driver LLM.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `default_level` | 0–3 | `2` | Projection level used when reading a secret file |
| `max_level` | 0–3 | `3` | Highest level the agent can request |
| `budget.tokens_per_file` | number | `4096` | Max tokens the driver may receive from one file across the session |
| `budget.ask_limit` | number | `20` | Max `ask_high_trust` calls per session |

Projection levels:
- **L0** — file metadata only (size, line count, language)
- **L1** — function/class signatures via treesitter (deterministic, no model)
- **L2** — semantic summary via local model (purpose, exports, dependencies)
- **L3** — control-flow summary via local model (branches, loops)

Large-file minimum-disclosure rule: files >200 lines are capped at L1 on first read.

```yaml
security:
  projection:
    default_level: 2
    max_level: 3
    budget:
      tokens_per_file: 8192
      ask_limit: 30
```

### `security.guard`

Three-layer output guard that runs on every projection before it reaches the driver.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `token_match.enabled` | bool | `true` | Reject projections containing known secret tokens |
| `token_match.min_token_length` | number | `7` | Minimum token length to flag |
| `token_match.min_line_length` | number | `24` | Minimum source line length to flag for line-leak detection |
| `token_match.known_safe_tokens` | list | `[]` | Tokens that are allowed in projections |
| `structure_fingerprint.enabled` | bool | `true` | Detect code lines by structural similarity |
| `structure_fingerprint.similarity_threshold` | 0–1 | `0.75` | Similarity above this triggers DENY |
| `meta_guard.enabled` | bool | `true` | Use local model to verify projection safety |
| `meta_guard.max_tokens` | number | `20` | Token budget for the meta-guard model verdict |
| `canary.auto_plant` | bool | `false` | Automatically insert canary tokens into secret files |

```yaml
security:
  guard:
    token_match:
      known_safe_tokens: ["v0.1.0", "MIT"]
    canary:
      auto_plant: true
```

---

## `tools`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowed` | list | all built-ins | Tool names the driver LLM may call |
| `bash.policy` | `"workspace_isolated" \| "unrestricted" \| "disabled"` | `"workspace_isolated"` | Bash execution scope |
| `bash.build_commands_pass_through` | bool | `true` | Allow `make`, `cmake`, `npm`, `bun`, `cargo`, `go build` etc. |
| `grep.exclude_dirs` | list | `["node_modules",".git","dist",".trust-proxy"]` | Directories skipped by grep |

Built-in tools: `read`, `read_file_range`, `edit`, `write`, `grep`, `glob`, `bash`, `ask_high_trust`, `submit_plan`, `flush_pending_writes`.

```yaml
tools:
  bash:
    policy: workspace_isolated
  grep:
    exclude_dirs: [node_modules, .git, dist, build, .cache]
```

---

## `session`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_iterations` | number | `50` | LLM ↔ tool loop limit |
| `workspace.enabled` | bool | `false` | Dual-workspace isolation (public sandbox + secret workspace) |
| `workspace.mode` | `"symlink" \| "copy"` | `"symlink"` | How public files are mirrored into the sandbox |
| `atomic_writes` | bool | `false` | Buffer all PROXY_WRITE calls; flush together via `flush_pending_writes` |

```yaml
session:
  max_iterations: 100
  workspace:
    enabled: true
    mode: symlink
  atomic_writes: true
```

---

## `audit`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | bool | `true` | Write NDJSON audit log |
| `log_dir` | string | `".trust-proxy/audit"` | Directory for audit files (relative to project root) |
| `retention_days` | number | `30` | Days before old logs are eligible for deletion |

---

## Legacy format (flat settings)

The original flat format is still supported for backward compatibility:

```yaml
default: public

secret:
  - src/core/**

derived: []

ignore:
  - "**/*.test.*"

settings:
  default_projection_level: 1
  max_projection_level: 3
  info_budget_ceiling: 4096
  ask_limit: 20
  known_safe_tokens: []
```

The new `version: "1"` format is preferred for new projects.

---

## Environment variable interpolation

Any string value in `providers` or `models` supports `${VAR}` syntax:

```yaml
providers:
  cloud:
    apiKey: ${ANTHROPIC_API_KEY}
  openai:
    apiKey: ${OPENAI_API_KEY}
```
