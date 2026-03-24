# Getting Started with Trust Agent

Get your first secure coding session running in under 15 minutes.

---

## Prerequisites

- An Anthropic API key (or OpenAI-compatible endpoint)
- A package manager — pick one:
  - **[pnpm](https://pnpm.io) ≥ 8** (recommended for most users, requires Node.js ≥ 18)
  - **[Bun](https://bun.sh) ≥ 1.0** (recommended for contributors / faster dev loop)

---

## 1. Clone and install

**Option A — pnpm (standard Node.js environment):**

```bash
git clone https://github.com/your-org/trust-agent
cd trust-agent
pnpm install
pnpm build                    # compiles TypeScript → dist/
cd packages/cli && pnpm link --global   # makes `trust-agent` available globally
```

**Option B — Bun (developers / contributors):**

```bash
git clone https://github.com/your-org/trust-agent
cd trust-agent
bun install
# No build step needed — Bun runs TypeScript source directly
# Run CLI with: bun run packages/cli/src/index.ts <command>
```

---

## 2. Pick a configuration mode

### Mode A — Cloud only (fastest setup)

Uses Claude as both the driver (coding LLM) and the trust proxy.
No local model needed. Projections run via treesitter (L0/L1 only without a local model).

```yaml
# .trust-policy.yml
version: "1"

assets:
  default: public
  rules:
    - pattern: "src/core/**"
      level: secret

models:
  driver:
    provider: anthropic
    model: claude-sonnet-4-20250514

settings:
  default_projection_level: 1
  info_budget_ceiling: 4096
  ask_limit: 20
```

Set your key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Mode B — Hybrid (recommended)

Driver = Claude (cloud). Projector/answerer = local model via Ollama.
L2/L3 semantic projections run locally; secrets never leave your machine.

```yaml
version: "1"

assets:
  default: public
  rules:
    - pattern: "src/core/**"
      level: secret

providers:
  ollama:
    api: openai-compatible
    baseURL: http://localhost:11434/v1

models:
  driver:
    provider: anthropic
    model: claude-sonnet-4-20250514
  projector:
    provider: ollama
    model: llama3.2
  answerer:
    provider: ollama
    model: llama3.2

security:
  projection:
    default_level: 2
    max_level: 3
```

Start Ollama and pull a model:

```bash
ollama pull llama3.2
```

### Mode C — Full local

All models local. No cloud calls at all.

```yaml
version: "1"

assets:
  default: public
  rules:
    - pattern: "src/**"
      level: secret

providers:
  local:
    api: openai-compatible
    baseURL: http://localhost:11434/v1

models:
  driver:
    provider: local
    model: llama3.2:70b
  projector:
    provider: local
    model: llama3.2
  answerer:
    provider: local
    model: llama3.2
  patcher:
    provider: local
    model: llama3.2
```

---

## 3. Initialize your project

```bash
cd /path/to/your/project
trust-agent init
```

This creates `.trust-policy.yml` from a template. Edit it to mark your proprietary directories as `secret`.

Verify the policy:

```bash
trust-agent validate
trust-agent validate --test-projection src/core/engine.ts   # preview all 4 projection levels
```

---

## 4. Run your first task

```bash
trust-agent run "Analyze the project structure and summarize the main components"
```

You will see real-time output like:

```
  ⟳ [PROXY_READ] src/core/engine.ts → projecting…
  ✓ [PROJ L1]   src/core/engine.ts 342tok (treesitter) [budget: 342/4096tok]
  ✓ [PASS]       read src/utils/helpers.ts (8ms)
  ⟳ [LLM]        The project contains...
```

When the LLM wants to edit a secret file, you'll be prompted:

```
⚠  [PROXY_WRITE] src/core/engine.ts (pending approval)
   Intent: Add cleanup() call at end of engine_run()
   Approve write? [y/n]
```

---

## 5. Resume a session

Every session is saved automatically. Resume where you left off:

```bash
trust-agent run --resume <session-id>
```

---

## 6. Check session history

```bash
trust-agent status                   # list recent sessions
trust-agent status <session-id>      # detailed audit for one session
```

---

## Common options

```
trust-agent run "task"
  --lang en|zh          Output language (default: en)
  --model <name>        Override driver model
  --provider <p>        Override provider (anthropic | openai | openai-compatible)
  --api-key <key>       Override API key
  --base-url <url>      Override base URL
  --resume <id>         Resume a previous session
  --verbose             Show verbose output
```

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `❌ .trust-policy.yml not found` | Run `trust-agent init` first |
| `DENY: info budget exhausted` | Increase `info_budget_ceiling` or use `ask_high_trust` |
| `L2/L3 projection falls back to L1` | Check that your local model is running and `baseURL` is correct |
| Writes always denied | Your `approvalCallback` is rejecting — type `y` at the prompt |
| Canary token alert | A secret token leaked through a projection — file a bug |
