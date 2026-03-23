# 07 — CLI 产品设计

## 1. 命令结构

```
trust-agent <command> [options]

Commands:
  init          初始化项目的 trust 配置
  run           启动安全编码 session
  status        查看当前项目的 trust 状态
  warmup        预生成所有 secret 文件的 projection cache
  canary        运行 canary 泄露测试
  audit         查看审计日志
  models        管理本地模型
  clean         清理 workspace 和缓存
```

## 2. 各命令详细设计

### 2.1 trust-agent init

```
用途：在项目中初始化 trust 配置

流程：
  1. 扫描项目文件
  2. 自动分析并推荐 trust policy
  3. 用户确认或编辑
  4. 生成 .trust-policy.yml
  5. 检查本地模型可用性
  6. 运行快速验证

参数：
  --auto          跳过交互，接受所有推荐
  --policy FILE   使用现有 policy 文件
  --no-models     跳过模型检查
```

交互流程：

```
$ trust-agent init

Scanning project...
Found 347 source files across 6 languages

Analyzing code for sensitivity markers...

Recommended trust policy:

  SECRET (3 files):
    src/core/crypto/aes.cpp           complexity: high, unique_symbols: 47
    src/core/crypto/key_derivation.cpp complexity: high, unique_symbols: 31
    src/core/engine/scheduler.cpp     complexity: high, unique_symbols: 28

  DERIVED (2 files):
    src/context/crypto_context.cpp    imports: crypto/aes.cpp
    src/context/engine_context.cpp    imports: engine/scheduler.cpp

  PUBLIC (342 files):
    everything else

Accept? [Y/n/edit] > y

Checking local models...
  Ollama: running at localhost:11434
  Projector (qwen3-coder:3b): not installed

Install recommended models? [Y/n] > y
  Pulling qwen3-coder:3b... done (1.8 GB)

Running verification...
  ✓ read src/core/crypto/aes.cpp → returns projection (not source)
  ✓ read src/api/handler.cpp → returns source (public file)
  ✓ guard check → no leaks detected

Created: .trust-policy.yml
Created: .trust-proxy/

Ready. Run `trust-agent run "your task"` to start.
```

### 2.2 trust-agent run

```
用途：启动一个安全编码 session

参数：
  trust-agent run "任务描述"
  --model MODEL       指定 cloud LLM（默认从配置读取）
  --provider PROVIDER 指定 provider（anthropic/openai/等）
  --local             强制全部使用本地模型（high-trust 模式）
  --verbose           显示详细的 gate 判定和 projection 信息
  --no-dashboard      关闭运行时仪表盘
  --dry-run           只显示会怎么做，不实际执行
  --continue SESSION  继续之前的 session
```

运行时界面：

```
$ trust-agent run "给 aes_encrypt 添加 GCM 模式支持"

╭─ Trust Session ──────────────────────────────────────╮
│ Model: claude-sonnet-4-20250514 (cloud, low-trust)            │
│ Local: qwen3-coder:3b (projector), qwen3-coder:7b (answerer) │
│ Policy: 3 secret, 2 derived, 342 public                      │
╰──────────────────────────────────────────────────────╯

Agent: 让我先了解一下当前的 aes 模块结构...

  → read src/core/crypto/aes.cpp
    [PROXY_READ] → L2 projection (512 tokens, cached)

  → read include/crypto.h
    [PASS] → source (public)

Agent: 我看到 aes_encrypt 当前支持 ECB 和 CBC 模式。
       我需要了解一下模式切换的内部机制...

  → ask_high_trust "aes_encrypt 内部如何根据 AesConfig.mode 选择加密模式？"
    [HIGH-TRUST] → answerer responded (347 tokens)

Agent: 明白了。让我规划修改方案...
       1. 在 AesConfig 中添加 GCM mode 常量
       2. 在 aes_encrypt 中添加 GCM 分支
       3. 添加 GCM 特有的 nonce/tag 参数处理
       4. 更新测试

  → edit include/crypto.h (添加 AES_MODE_GCM 常量)
    [PASS] → applied (public file)

  → edit src/core/crypto/aes.cpp (intent: "添加 GCM 模式分支...")
    [PROXY_WRITE] → patcher applied (14 lines changed)

  → edit tests/test-aes.cpp (添加 GCM 测试用例)
    [PASS] → applied (public file)

  → bash cmake --build build && ctest
    [PASS] → build ok, 12/12 tests passed

╭─ Session Summary ────────────────────────────────────╮
│ Duration: 3m 42s                                     │
│ Secret files accessed: 1 (src/core/crypto/aes.cpp)   │
│ Projections: 2 (1 cached)                            │
│ High-trust calls: 3 (1 projection, 1 answer, 1 patch)│
│ Guard blocks: 0                                      │
│ Public ops: 23 (all passthrough)                     │
│ Info budget: aes.cpp ██████░░░░ 58% remaining        │
╰──────────────────────────────────────────────────────╯
```

### 2.3 trust-agent status

```
$ trust-agent status

Project: /home/user/my-project
Policy:  .trust-policy.yml (last modified: 2026-03-19)

Files:
  Secret:  3 files  (src/core/crypto/**, src/core/engine/scheduler.cpp)
  Derived: 2 files  (src/context/**)
  Public:  342 files

Projection cache:
  Entries: 5 (3 secret L2, 2 derived L1)
  Size: 12 KB
  Freshness: all valid (no source changes since last projection)

Local models:
  qwen3-coder:3b  ✓ running (projector)
  qwen3-coder:7b  ✓ running (answerer)
  qwen3-coder:14b ✗ not installed (patcher - edit disabled)

Sessions: 7 total, last: 2h ago
Canary tests: 2 run, 2 passed
```

### 2.4 trust-agent models

```
$ trust-agent models

Required:
  projector  qwen3-coder:3b   ✓ installed  1.8 GB
  guard      (rule engine)     ✓ built-in

Optional:
  answerer   qwen3-coder:7b   ✓ installed  4.5 GB
  patcher    qwen3-coder:14b  ✗ not found  8.2 GB

$ trust-agent models pull patcher
Pulling qwen3-coder:14b... ████████████ 100%  8.2 GB
Done.

$ trust-agent models test
Testing projector... ✓ (avg 1.2s per projection)
Testing answerer...  ✓ (avg 2.8s per answer)
Testing patcher...   ✓ (avg 4.1s per patch)
Testing guard...     ✓ (avg 3ms per check)
```

## 3. 配置文件

### 3.1 项目配置：.trust-policy.yml

```yaml
# 见 02-trust-gate-design.md 中的完整格式
default: public
secret:
  - src/core/crypto/**
  - src/core/engine/scheduler.cpp
derived:
  - src/context/**
ignore:
  - "**/*_test.cpp"
settings:
  default_projection_level: 2
  max_projection_level: 3
  info_budget_ceiling: 4096
  ask_limit: 20
```

### 3.2 用户配置：~/.config/trust-agent/config.yml

```yaml
# 默认 cloud LLM
provider: anthropic
model: claude-sonnet-4-20250514

# API key（或通过环境变量）
# anthropic_api_key: sk-...

# Ollama 配置
ollama:
  host: http://localhost:11434
  timeout: 30000

# 模型覆盖
models:
  projector: trust-proxy-projector:3b
  answerer: trust-proxy-answerer:7b
  patcher: trust-proxy-patcher:14b

# UI 偏好
dashboard: true
verbose: false
```

## 4. 自动推荐算法

init 时自动分析文件敏感度：

```typescript
type SensitivitySignal = {
  file: string
  score: number           // 0-1
  reasons: string[]
}

function analyzeSensitivity(file: string, projectContext: ProjectContext): SensitivitySignal {
  let score = 0
  const reasons: string[] = []

  // 信号 1：文件名模式
  const sensitivePatterns = [/crypto/i, /secret/i, /private/i, /engine/i, /core/i, /algo/i, /proprietary/i]
  if (sensitivePatterns.some(p => p.test(file))) {
    score += 0.3
    reasons.push("filename matches sensitive pattern")
  }

  // 信号 2：代码复杂度
  const complexity = computeCyclomaticComplexity(file)
  if (complexity > 20) {
    score += 0.2
    reasons.push(`high cyclomatic complexity: ${complexity}`)
  }

  // 信号 3：唯一标识符密度
  const uniqueSymbols = countUniqueInternalSymbols(file, projectContext)
  if (uniqueSymbols > 20) {
    score += 0.2
    reasons.push(`${uniqueSymbols} unique internal symbols`)
  }

  // 信号 4：被依赖但少依赖外部（核心模块特征）
  const deps = projectContext.dependencyGraph.get(file)
  if (deps && deps.dependedOnBy > 5 && deps.dependsOn < 3) {
    score += 0.2
    reasons.push("core module pattern (high fan-in, low fan-out)")
  }

  // 信号 5：git blame 集中度
  const authors = projectContext.gitBlame.get(file)
  if (authors && authors.uniqueAuthors <= 2) {
    score += 0.1
    reasons.push("restricted authorship (≤2 contributors)")
  }

  return { file, score: Math.min(score, 1), reasons }
}

// 推荐阈值
function recommendLevel(signal: SensitivitySignal): AssetLevel {
  if (signal.score >= 0.6) return "secret"
  if (signal.score >= 0.3) return "derived"
  return "public"
}
```

## 5. 错误和降级体验

| 场景 | 用户看到的 | 建议操作 |
|------|----------|---------|
| Ollama 未运行 | `⚠ Local models unavailable. Secret files will be inaccessible.` | `trust-agent models check` |
| Cloud API key 无效 | `✗ Provider authentication failed` | 检查配置 |
| Projection 生成失败 | `⚠ Could not project src/x.cpp (model error). Retrying with L1...` | 自动降级 |
| Patcher 失败 | `⚠ Patch failed. Intent and attempted diff saved to .trust-proxy/failed-patches/` | 手动 review |
| 信息预算耗尽 | `⚠ Info budget exhausted for src/x.cpp. Switch to local mode? [Y/n]` | 切换或新 session |
| Guard 检测到泄露 | `✗ Guard: projection contains internal token "xxx". Regenerating at lower level...` | 自动重试 |
