# Trust Agent 用户使用手册

> 版本：Sprint 5 (2026-03-22)
> 对应代码：packages/cli + packages/core

---

## 目录

1. [产品简介](#1-产品简介)
2. [安装](#2-安装)
3. [快速开始](#3-快速开始)
4. [配置文件详解](#4-配置文件详解)
5. [运行任务](#5-运行任务)
6. [实时输出说明](#6-实时输出说明)
7. [PROXY_WRITE 审批流程](#7-proxy_write-审批流程)
8. [Session 持久化与恢复](#8-session-持久化与恢复)
9. [投影系统](#9-投影系统)
10. [投影质量调试工具](#10-投影质量调试工具)
11. [信息预算](#11-信息预算)
12. [审计日志](#12-审计日志)
13. [查看 Session 状态](#13-查看-session-状态)
14. [安全加固（Sprint 3）](#14-安全加固sprint-3)
15. [常见问题](#15-常见问题)
16. [命令速查](#16-命令速查)

---

## 1. 产品简介

Trust Agent 是一个双模型架构的安全编码助手：

```
你的任务
   │
   ▼
云端 LLM（低信任）─── 只能看到 public 文件 + secret 文件的"投影"
   │                    驱动编码决策，调用工具
   │
   ▼
Trust Gate ─── 拦截所有工具调用，根据文件分类裁决
   │
   ├── public 文件  →  PASS（直接执行）
   ├── secret 文件读取  →  PROXY_READ（返回投影摘要，不返回源码）
   ├── secret 文件修改  →  PROXY_WRITE（调本地模型执行，用户审批）
   └── grep 结果  →  REDACT（裁剪掉 secret 文件的匹配行）
   │
   ▼
本地模型（高信任）─── 可以看到 secret 文件原文
   │                    生成投影摘要、回答问题、执行修改
   ▼
Guard（三层过滤）─── 确保本地模型的输出不泄露源码
```

**核心保证**：secret 文件的原始代码永不发送到云端 LLM。

---

## 2. 安装

### 前提条件
- 云端 LLM API Key（Anthropic / OpenAI / 兼容接口均可）
- 可选：本地推理服务（Ollama、llama.cpp、vLLM 等）用于处理 secret 文件

### 安装二进制

```bash
# 将 trust-agent 二进制放到 PATH
cp trust-agent-linux-x64 /usr/local/bin/trust-agent
chmod +x /usr/local/bin/trust-agent

# 验证
trust-agent --help
```

### 从源码构建

```bash
git clone <repo>
cd Secure-coding-agent

# 安装依赖
bun install

# 构建
cd packages/cli
bun run build

# 安装到本地
cp dist/trust-agent-linux-x64/trust-agent ~/.local/bin/trust-agent
```

---

## 3. 快速开始

### Step 1 — 初始化配置

在你的项目根目录运行：

```bash
cd /path/to/your-project
trust-agent init
```

`init` 会自动扫描目录结构，生成 `.trust-policy.yml`，并推荐 secret 文件范围。

### Step 2 — 编辑配置

打开 `.trust-policy.yml`，至少完成两处：

1. **确认 secret 规则**（哪些目录不能发给云端）
2. **填写 API 信息**（云端模型的 provider 和 key）

最简配置示例（纯云端，无本地模型）：

```yaml
version: "1"

assets:
  default: public
  rules:
    - pattern: "src/**"
      level: secret

providers:
  mycloud:
    api: openai-compatible
    baseURL: https://your-api-endpoint/v1
    apiKey: sk-xxxxx

models:
  driver:
    provider: mycloud
    model: your-model-name
```

### Step 3 — 验证配置

```bash
trust-agent validate
```

输出示例：
```
✓ 配置文件语法         YAML 解析成功
✓ secret 文件规则      1 条规则: src/**
✓ driver 模型          openai-compatible/your-model-name
⚠ high_trust.projector 未配置（secret 文件处理能力受限）
```

### Step 4 — 运行第一个任务

```bash
trust-agent run "读取 README.md，告诉我这个项目是什么"
```

---

## 4. 配置文件详解

`.trust-policy.yml` 分为六个部分：

### 4.1 assets — 文件分类

```yaml
assets:
  default: public          # 未匹配的文件默认为 public

  rules:
    - pattern: "src/**"    # glob 模式
      level: secret        # secret | derived | public
      reason: 核心业务逻辑

  ignore:                  # ignore 优先于 rules
    - "**/*.test.*"        # 测试文件不作为 secret
    - "**/types.h"         # 接口声明文件可公开
```

**三种级别：**

| 级别 | 含义 |
|------|------|
| `secret` | 核心代码，永不发送到云端 LLM，只发投影 |
| `derived` | 从 secret 派生（如生成的文档），可部分发送 |
| `public` | 可直接发送（README、配置、测试等） |

### 4.2 providers — API 提供商

```yaml
providers:
  # Anthropic 云端
  anthropic:
    api: anthropic
    apiKey: ${ANTHROPIC_API_KEY}     # 支持 ${ENV_VAR} 插值

  # OpenAI 云端
  openai:
    api: openai
    apiKey: ${OPENAI_API_KEY}

  # openai-compatible（本地或云端兼容接口）
  local:
    api: openai-compatible
    baseURL: http://localhost:11434/v1   # Ollama 本地示例

  # 云端 openai-compatible 示例（DeepSeek、iflow、月之暗面等）
  mycloud:
    api: openai-compatible
    baseURL: https://apis.example.com/v1
    apiKey: ${MY_API_KEY}
```

> ⚠ `api` 字段只接受枚举值：`anthropic` | `openai` | `openai-compatible`，不要填 URL。URL 放在 `baseURL`。

### 4.3 models — 模型角色分配

```yaml
models:
  # 云端驱动模型（低信任）— 必填
  driver:
    provider: mycloud
    model: qwen3-max

  # 以下三项为可选，不填则 L2/L3 投影降级到 L1
  projector:           # 生成 L2/L3 投影摘要（推荐轻量模型）
    provider: local
    model: qwen2.5-coder:1.5b

  answerer:            # 回答 ask_high_trust 问题（推荐较强模型）
    provider: local
    model: qwen2.5-coder:7b

  patcher:             # 修改 secret 文件
    provider: local
    model: qwen2.5-coder:7b
```

**不配置本地模型的影响：**
- secret 文件只能得到 L0（文件大小）或 L1（函数签名）投影
- 无法使用 `ask_high_trust` 工具
- 无法通过 PROXY_WRITE 修改 secret 文件

### 4.4 security — 安全参数

```yaml
security:
  projection:
    default_level: 2           # 默认投影级别（0-3）
    max_level: 3
    budget:
      tokens_per_file: 4096    # 每个 secret 文件的 token 预算
      ask_limit: 20            # 每 session 可问 ask_high_trust 次数

    # Sprint 2 新增：外置 Prompt（可覆盖内建提示词）
    prompts:
      l2: |
        Generate a behavior summary...
      l3: |
        Generate pseudocode...

  guard:
    token_match:
      enabled: true
      known_safe_tokens: []    # 不视为泄漏的白名单 token

    structure_fingerprint:
      enabled: true
      similarity_threshold: 0.75   # 控制流相似度阈值（0~1）

    meta_guard:
      enabled: true
      max_tokens: 20           # 语义判断的最大 token 数
```

**四级投影（projection_level）：**

| 级别 | 生成方式 | 内容 | 示例 token 数 |
|------|----------|------|--------------|
| L0 | stat | 文件名、行数、大小 | ~15 |
| L1 | treesitter（正则） | 函数签名、类名、枚举、依赖 | ~100-300 |
| L2 | 本地模型 | 行为摘要（Purpose / Exports / Dependencies） | ~200-400 |
| L3 | 本地模型 | 伪代码（FUNCTION / IF / FOR / [REDACTED]） | ~300-600 |

### 4.5 tools — 工具配置

```yaml
tools:
  bash:
    policy: workspace_isolated    # workspace_isolated | unrestricted | disabled
    build_commands_pass_through: true   # cmake/make/git 走真实目录
  grep:
    exclude_dirs: [node_modules, .git, dist, .trust-proxy]
```

### 4.6 session — 会话配置

```yaml
session:
  max_iterations: 50     # LLM 最大对话轮数（防死循环）
  workspace:
    enabled: false        # 双 workspace 物理隔离（高安全模式）
```

---

## 5. 运行任务

### 基本用法

```bash
trust-agent run "任务描述"
```

### 常用选项

```bash
# 指定模型（覆盖配置文件）
trust-agent run "任务" --model qwen3-max

# 指定提供商
trust-agent run "任务" --provider openai-compatible --base-url https://... --api-key sk-xxx

# 指定项目目录
trust-agent run "任务" --project /path/to/project

# 恢复中断的 session
trust-agent run --resume abc12345

# 详细输出
trust-agent run "任务" --verbose
```

### 任务示例

```bash
# 只读任务（触发 PASS）
trust-agent run "读取 README.md，告诉我这个项目的主要功能"

# 读取 secret 文件（触发 PROXY_READ）
trust-agent run "分析 src/engine.h 的主要数据结构和接口"

# 修改 secret 文件（触发 PROXY_WRITE，需要用户审批）
trust-agent run "在 src/engine.h 末尾添加注释 // TODO: optimize"

# 跨文件任务
trust-agent run "根据 src/api.h 的接口声明，在 public/README.md 中添加 API 文档"
```

---

## 6. 实时输出说明

运行时终端会显示每次工具调用的信任域裁决（Sprint 1 新增）：

```
  ✓ [PASS]       read README.md
  ⟳ [PROXY_READ] src/engine.h → 投影中...
  ✓ [PROJ L1]    src/engine.h 211tok (treesitter)
  ✓ [PASS]       read README.md
  ⟳ [LLM]        这是一个高性能 C++ 推理引擎...
  ✓ [PASS]       bash
```

**符号含义：**

| 符号 | 类型 | 含义 |
|------|------|------|
| `✓ [PASS]` | 绿色 | 工具调用直接通过，文件为 public |
| `⟳ [PROXY_READ]` | 黄色 | secret 文件读取，正在生成投影 |
| `✓ [PROJ L1]` | 绿色 | 投影完成，显示级别 + token 数 + 生成方式 |
| `⚠ [PROXY_WRITE]` | 橙色 | secret 文件即将被修改，等待审批 |
| `✓ [REDACT]` | 绿色 | grep 结果中 secret 文件内容已裁剪 |
| `✗ [DENY]` | 红色 | 请求被拒绝（预算超限等） |
| `⟳ [LLM]` | 蓝色 | LLM 开始生成，后面跟流式 token |

---

## 7. PROXY_WRITE 审批流程

当 LLM 请求修改 secret 文件时，会触发交互式审批（Sprint 1 新增）：

```
⚠  [PROXY_WRITE] src/engine.h
   意图: 在文件末尾添加注释 // TODO: optimize
   批准写入? [y/n]
```

输入 `y` 确认后，本地 Patcher 模型执行修改并输出结果：
```
[PROXY_WRITE OK] +1 行添加注释
备份: .trust-proxy/backup/engine.h.20260322-143022
```

输入 `n` 拒绝：
```
[DENIED by user] 用户拒绝修改 src/engine.h
```

**注意事项：**
- PROXY_WRITE 需要在 `models.patcher` 中配置本地模型
- 每次 PROXY_WRITE 执行前会自动备份原文件
- 如果 `models.patcher` 未配置，修改请求会被拒绝并告知原因

---

## 8. Session 持久化与恢复

每次 `trust-agent run` 完成后，session 自动保存（Sprint 1 新增）：

```
✅ Session 完成: abc12345
   迭代次数: 6
   恢复命令: trust-agent run --resume abc12345
```

session 文件保存在：`.trust-proxy/sessions/<id>.json`

### 恢复中断的任务

```bash
# Ctrl+C 中断后，或 session 因为超时/报错终止
trust-agent run --resume abc12345
```

恢复时会加载历史消息，从中断处继续，不重复已完成的工作。

### 查看已有 session

```bash
ls .trust-proxy/sessions/
```

---

## 9. 投影系统

投影（Projection）是 trust-agent 的核心机制：当 LLM 请求读取 secret 文件时，实际返回的是该文件的「摘要」，而非原始代码。

### 四级投影的实际输出

**L0 — 文件信息（stat）**
```
[PROJECTED L0] engine.h
File exists, 621 lines, 17719 bytes
```

**L1 — 函数签名（treesitter/regex）**
```
[PROJECTED L1] engine.h

## Exports
- engine_init(config* cfg) → engine_t*
- engine_run(engine_t* e, const char* prompt) → int
- engine_free(engine_t* e)

## Classes
- enum llm_arch
- struct engine_config
- struct engine_t

## Dependencies
#include "ggml.h", #include <string>

Lines: 621
```

**L2 — 行为摘要（本地模型生成）**
```
[PROJECTED L2] engine.h

## Purpose
This file defines the core inference engine interface for running LLM models.
It manages model loading, memory allocation, and token generation.

## Exports
- engine_init(config) → handle: Allocates and initializes engine resources,
  loads model weights, returns opaque handle or NULL on failure
- engine_run(engine, prompt) → int: Runs inference on the prompt,
  returns token count or negative error code
- engine_free(engine): Releases all resources, safe to call with NULL

## Dependencies
ggml (tensor ops), standard C library
```

**L3 — 伪代码（本地模型生成）**
```
[PROJECTED L3] engine.h

## Purpose
Core inference engine with resource lifecycle management.

## Pseudocode

FUNCTION engine_init(config):
  validate config fields
  IF config invalid: RETURN NULL
  allocate engine struct
  load model file from config path
  IF load fails: free resources, RETURN NULL
  initialize [REDACTED] internal buffers with size from config
  RETURN engine handle

FUNCTION engine_run(engine, prompt):
  tokenize prompt using engine's tokenizer
  FOR each token in prompt:
    run forward pass through [REDACTED] layers
  WHILE not end-of-sequence AND count < [REDACTED]:
    sample next token using [REDACTED] strategy
    IF stop token: BREAK
  RETURN total tokens generated
```

### 投影降级规则

```
请求 L2/L3
   │
   ├── 本地模型未配置 → 降级到 L1
   ├── 本地模型连接失败 → 降级到 L1（BUG-5 修复）
   ├── Guard 检测到泄露 → 降级到 L(n-1) 重试
   └── 正常 → 返回 L2/L3 内容
```

---

## 10. 投影质量调试工具

Sprint 2 新增两种方式检查投影质量：

### 方式一：CLI 命令（推荐）

```bash
trust-agent validate --test-projection <file>
```

示例：
```bash
cd /path/to/your-project
trust-agent validate --test-projection src/engine.h
```

输出：
```
🔬 投影测试: /path/to/src/engine.h
   Projector: http://0.0.0.0:9999/v1 → qwen3.5-4b

────────────────────────────────────────────────────
L0 投影  [stat]         16 tokens  2ms
────────────────────────────────────────────────────
[PROJECTED L0] engine.h
File exists, 312 lines, 8920 bytes

────────────────────────────────────────────────────
L1 投影  [treesitter]  148 tokens  1ms
────────────────────────────────────────────────────
[PROJECTED L1] engine.h
...

────────────────────────────────────────────────────
L2 投影  [model]       287 tokens  1240ms
────────────────────────────────────────────────────
[PROJECTED L2] engine.h
...
```

### 方式二：开发者脚本

```bash
bun run packages/core/script/test-projection.ts <file> [project-dir]
```

输出格式相同，适合在开发 trust-agent 本身时使用。

### 自定义投影 Prompt（Sprint 2 新增）

如果内建的 L2/L3 Prompt 对你的模型效果不佳，可在配置中覆盖：

```yaml
security:
  projection:
    prompts:
      l2: |
        Analyze this code file and generate a Chinese behavior summary.
        Format:
        ## 用途
        一到两句话描述文件作用。
        ## 导出接口
        每个函数一行：函数名(参数) → 返回值：行为描述
        ## 依赖
        主要依赖模块列表
        不要包含任何源码。

      l3: |
        Generate Chinese pseudocode for this file.
        Rules: use IF/FOR/WHILE keywords, replace all constants with [已编辑].
```

---

## 11. 信息预算

每个 secret 文件都有 token 预算上限（默认 4096 tokens），防止通过大量投影请求拼凑出完整源码。

### 预算规则

- 每次 PROXY_READ 消耗该文件的 token 配额
- 每次 `ask_high_trust` 也计入配额
- 配额耗尽后，该文件的读取请求会被 DENY
- 每 session 全局限制 `ask_high_trust` 次数（默认 20 次）

### Session 结束时的预算报告

```
信息预算:
  - 追踪文件: 3
  - 总 tokens: 1847
  - 总提问数: 5
```

### 调整预算（高安全场景）

```yaml
security:
  projection:
    budget:
      tokens_per_file: 1024    # 收紧到 1024，只允许少量投影
      ask_limit: 5             # 每 session 最多问 5 次
```

---

## 12. 审计日志

每个 session 的所有工具调用和 Gate 裁决都记录在：

```
.trust-proxy/audit/<session-id>.ndjson
```

每行是一个 JSON 事件，格式如下：

```json
{"type":"gate","timestamp":"...","sessionId":"abc12345","toolName":"read","filePath":"src/engine.h","verdict":"PROXY_READ","durationMs":1}
{"type":"projection","timestamp":"...","sessionId":"abc12345","filePath":"src/engine.h","level":1,"tokenCount":148,"source":"treesitter","guardPassed":true}
{"type":"gate","timestamp":"...","sessionId":"abc12345","toolName":"bash","filePath":null,"verdict":"PASS","durationMs":0}
```

查看审计日志：
```bash
cat .trust-proxy/audit/abc12345.ndjson | jq .
```

---

## 13. 查看 Session 状态

```bash
# 查看所有 session
trust-agent status

# 查看特定 session 详情
trust-agent status abc12345
```

---

## 14. 安全加固（Sprint 3）

Sprint 3 新增了四项主动安全机制，无需额外代码即可通过配置开启。

---

### 14.1 Canary Token 自动植入

**作用：** 检测 secret 文件内容是否在 session 期间泄露到 LLM 输出中。

**开启方式：** 在 `.trust-policy.yml` 中设置：

```yaml
security:
  guard:
    canary:
      auto_plant: true   # 每次 session 开始前自动植入
```

**工作原理：**
1. `run()` 开始前，从 secret 文件中选取最多 3 个文件
2. 每个文件注入一行注释：`// CANARY_<16位随机hex>`
3. LLM 运行期间，若 canary token 出现在任何消息中 → 检测为泄露
4. `run()` 结束后自动恢复文件（移除注入行）
5. 终端显示摘要，`RunResult.canaryResult` 包含详细结果

**终端输出示例：**

```
  🐦 [CANARY]     植入 2 个 token
  ...（session 运行）...
🐦 Canary: 2 个 token 全部安全 (canary_test.passed: true)
```

如果检测到泄露：
```
🚨 Canary: 1/2 个 token 泄露！(canary_test.passed: false)
```

---

### 14.2 Prompt Injection 检测（降级保护）

**作用：** 防止攻击者在 secret 文件中嵌入恶意指令，劫持本地模型在生成 L2/L3 投影时执行任意操作。

**防护机制（自动开启，无需配置）：**

Gate 在执行 `PROXY_READ`（L2/L3）前，先扫描文件内容。若检测到注入指令，强制降级为 L1（确定性 treesitter，不经过本地模型）：

```
[WARN] src/engine.h 包含疑似 Prompt Injection，已强制降级为 L1
```

**检测的攻击模式：**
- `ignore previous instructions` / `IGNORE ALL PREVIOUS INSTRUCTIONS`
- `disregard your rules` / `forget your training`
- `you are now a different assistant`
- 模型分隔符：`[INST]`、`<|im_start|>`、`<|system|>`、`<|im_end|>`
- 行首角色注入：`system:`、`Human:`、`Assistant:`

**精度（测试数据）：**
- 攻击样本（7种变体）：100% 检测率
- 正常 C++/TypeScript 代码：0% 误报率

---

### 14.3 Confused Deputy 防护

**作用：** 防止 LLM 被骗生成包含恶意指令的 `intent` 字符串，通过 PROXY_WRITE 传给本地 Patcher 执行危险操作。

**防护机制（自动开启）：**

Gate 在处理 PROXY_WRITE 前，检查 `intent` 字段是否包含注入指令。若检测到，返回 DENY：

```
[DENIED] PROXY_WRITE intent 包含疑似注入指令，已拒绝修改 src/engine.h
```

**额外检测的 Patcher 专项模式：**
- `delete entire/whole/all/every`
- `rm -rf`
- `exec(` / `system(` / `eval(`

---

### 14.4 编码绕过检测（Base64/Hex）

**作用：** 防止攻击者将 secret token 进行 base64 或 hex 编码后混入投影输出，绕过原有的字符串匹配。

**防护机制（自动开启）：**

Guard Layer 1 现在对投影内容中的编码块进行解码，并对解码内容重新进行 token 匹配：

```
violation: token_leak  detail: [encoded] proprietaryScore  severity: high
```

**检测逻辑：**
- 提取 base64 块（≥20字符，以 `=?` 结尾）
- 提取 hex 块（≥16字符，偶数长度）
- 解码并过滤可打印 ASCII（避免二进制误报）
- 将解码内容加入 token 匹配检测

---

### 14.5 审计日志 HMAC 签名

**作用：** 确保审计日志的完整性，防止日志被篡改。

**机制：** 每次 session 启动时生成 32字节随机密钥，保存在：

```
.trust-proxy/audit/<session-id>.key   (权限: 0o600)
```

每条日志条目附加 HMAC-SHA256 签名字段 `_sig`：

```json
{"type":"gate","timestamp":"...","sessionId":"abc","toolName":"read","verdict":"PASS","durationMs":1,"_sig":"a3f2c1d4e5b6a7c8"}
```

**验证命令：**

```bash
# 验证所有 session 的签名完整性
trust-agent status --verify

# 验证特定 session
trust-agent status --verify <session-id>
```

**输出示例（签名完整）：**

```
🔐 审计日志签名验证 (1 个 session)

  ✓ abc12345  8 条记录全部有效

✅ 签名链完整，所有日志未被篡改
```

**输出示例（旧 session，无签名）：**

```
  ✗ 05410309  篡改: 0  缺签名: 1  有效: 0/1
```

> 注意：Sprint 3 之前的旧 session 不包含 `_sig` 字段，显示"缺签名"属于预期行为，不代表日志被篡改。

---

## 15. 常见问题

### Q: 运行后显示"追踪文件: 0 / 总 tokens: 0"

**原因：** 本地模型（projector）连接失败，L2/L3 投影抛出异常，导致 budget 记录被跳过。

**修复（已在 Sprint 1/2 修复）：** 本地模型失败时自动降级到 L1，budget 正常记录。如仍出现，检查：
```bash
# 确认本地模型是否运行
curl http://0.0.0.0:9999/v1/models

# 检查配置中 projector.baseURL 是否正确
trust-agent validate
```

### Q: `.trust-policy.yml` 中 providers 写法报错

**原因：** `api` 字段写了 URL（应该是枚举值），URL 应放在 `baseURL`。

**正确写法：**
```yaml
providers:
  myprovider:
    api: openai-compatible      # ✅ 枚举值
    baseURL: https://...        # ✅ URL 放这里
    apiKey: sk-xxx
```

**错误写法：**
```yaml
providers:
  myprovider:
    api: https://...            # ❌ api 不接受 URL
```

### Q: PROXY_WRITE 触发但没有出现审批提示

**原因：** 未配置 `approvalCallback`（直接使用 SDK 而非 CLI）或 `models.patcher` 未配置。

**解决：** 确认使用 `trust-agent run` 命令，且配置了 `models.patcher`。

### Q: secret 文件被直接读取了（没有触发 PROXY_READ）

**可能原因：**
1. 文件匹配了 `assets.ignore` 规则
2. 文件路径使用了相对路径，未命中 glob 规则
3. LLM 通过 bash 命令绕过了 Gate（如 `cat src/engine.h`）

**检查：**
```bash
# 验证文件分类
trust-agent validate
# 查看 .trust-policy.yml 中 assets.ignore 是否误匹配
```

### Q: L2/L3 投影内容为空或乱码

**原因：** 本地小模型对英文指令响应不稳定，或 context 超长。

**解决：** 在配置中覆盖 Prompt（见[第 10 节](#10-投影质量调试工具)），或使用更大的本地模型。

### Q: `bun test` 失败

```bash
cd Secure-coding-agent
bun test
```

如果测试失败，检查 `packages/eval/fixtures/` 中的测试 fixture 配置。

---

## 16. 命令速查

```bash
# 初始化项目
trust-agent init [path]

# 验证配置
trust-agent validate [path]
trust-agent validate --check-connectivity        # 同时测试 API 连通性
trust-agent validate --test-projection <file>    # 输出文件四级投影（Sprint 2）

# 运行任务
trust-agent run "任务描述"
trust-agent run "任务" --model <model>
trust-agent run "任务" --provider <p> --api-key <key> --base-url <url>
trust-agent run "任务" --project <dir>
trust-agent run --resume <session-id>            # 恢复 session（Sprint 1）

# 查看状态
trust-agent status [session-id]
trust-agent status --verify                      # 验证所有 session HMAC 签名（Sprint 3）
trust-agent status --verify <session-id>         # 验证特定 session 签名（Sprint 3）

# 帮助
trust-agent help
trust-agent --help
```

### ask_high_trust 工具（在任务中使用）

当 LLM 需要了解 secret 文件的具体行为时，可以调用此工具：

```
ask_high_trust(
  question: "这个函数在 token 超过上限时的处理逻辑是什么？",
  files: ["src/engine.h"],
  context: "我在为 engine_run 添加错误处理"
)
```

每次调用计入 `ask_limit` 预算（默认每 session 20 次）。

---

## 附录：项目文件结构

```
your-project/
├── .trust-policy.yml          # 信任策略配置
├── .trust-proxy/
│   ├── audit/
│   │   ├── <session-id>.ndjson  # 审计日志（含 _sig HMAC 签名，Sprint 3）
│   │   └── <session-id>.key     # 审计签名密钥（0o600，Sprint 3）
│   ├── sessions/
│   │   └── <session-id>.json    # session 持久化（Sprint 1）
│   ├── cache/
│   │   └── projections/         # 投影缓存
│   └── backup/                  # PROXY_WRITE 前的文件备份
├── src/                         # secret 文件（永不发送到云端）
└── README.md                    # public 文件（可直接发送）
```
