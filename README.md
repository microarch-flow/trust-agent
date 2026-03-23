# Trust Proxy — 安全编码 Agent

> 用云端强模型驱动编码任务，用本地小模型守护核心代码，Secret 文件永不离开本地。

## 核心思路

企业使用云端大模型（GPT-4o、Claude Sonnet 等）辅助编码时面临一个矛盾：模型能力越强，就越需要读取更多代码上下文，而核心业务逻辑、加密算法、专有评分模型等文件一旦发送到云端，就面临数据泄露风险。

Trust Proxy 的解法是**双模型双信任域**：

```
云端 LLM（低信任）          本地模型集群（高信任）
─────────────────           ────────────────────────
• 强模型，驱动任务           • 小模型，私有部署
• 只看 public 文件原文       • 可读 secret 文件原文
• 看 secret 文件的"投影"     • 生成投影 / 回答问题 / 修改文件
• 永远看不到源码             • 结果经 Guard 过滤后才返回
```

Secret 文件的源码**永远不离开本地**，云端 LLM 收到的只是经过安全过滤的结构摘要。

---

## 功能列表

### 信任策略（Trust Policy）
- YAML 格式配置文件 `.trust-policy.yml`，用 glob 模式声明 `secret` / `derived` / `public` 文件
- 优先级：`ignore` > `secret` > `derived` > `public`
- 支持 `trust-agent init` 扫描项目结构自动生成策略模板

### Trust Gate（安全拦截器）
所有工具调用经过 Trust Gate 评估，返回五种裁决：

| 裁决 | 触发条件 | 处理方式 |
|------|---------|---------|
| `PASS` | public 文件 | 直接执行 |
| `PROXY_READ` | 读 secret 文件 | 返回投影摘要 |
| `PROXY_WRITE` | 写 secret 文件 | 交由本地 Patcher |
| `REDACT` | grep 搜索 | 过滤 secret 文件匹配行 |
| `DENY` | 预算耗尽 / 异常 | 拒绝并返回原因 |

### 四级投影系统（Projection Engine）
Secret 文件不直接发送，而是生成分级摘要：

| 级别 | 内容 | 生成方式 |
|------|------|---------|
| L0 | 文件大小、修改时间 | 纯 stat，无模型 |
| L1 | 导出函数/类签名（仅 export 项） | 正则提取，无模型 |
| L2 | 行为摘要（输入输出副作用） | 本地 projector 模型 |
| L3 | 自然语言伪代码（控制流描述） | 本地 projector 模型 |

投影结果带哈希缓存（内存 + 磁盘），文件未变化不重复计算。

### 三层 Guard（泄漏检测）
模型生成的 L2/L3 投影和 ask 回答，在返回给云端 LLM 前经过三层检测：

- **Layer 1 — Token 匹配**：提取 secret 文件内部标识符，检测是否出现在输出中
- **Layer 2 — 结构指纹**：提取控制流序列（if/for/while/return/try/catch），用 trigram Jaccard 相似度与 secret 文件对比，阈值默认 0.75
- **Layer 3 — Meta-Guard**：调用本地模型做语义审查，判断输出是否包含可复现的实现逻辑（SAFE / UNSAFE）

任意层失败 → 降级投影或拒绝输出。Meta-Guard 调用失败时 fail-open，不阻断流程。

### 高信任模型池（High-Trust Pool）
三种角色，支持任何 OpenAI-compatible API（Ollama、vLLM、LMStudio、SGLang 等）：

- **projector**：生成 L2/L3 投影
- **answerer**：回答 `ask_high_trust` 问题（文字描述，不含源码）
- **patcher**：理解修改意图，生成修改后文件，计算 diff 后写入

### Patcher（安全写入）
云端 LLM 无法直接修改 secret 文件。触发 `PROXY_WRITE` 时：
1. 备份原文件
2. 本地 patcher 模型读取源码 + 理解意图 → 生成修改后全文
3. 计算行级 diff
4. Guard 检查 diff 摘要
5. 写入文件，返回 `[PATCH APPLIED] N lines changed` 给云端 LLM

### 信息预算（Info Budget）
- 每个 secret 文件有 token 上限（默认 4096），累计用量超限后拒绝继续投影
- `ask_high_trust` 有全局次数上限（默认 20 次/session）

### 审计日志
每次 Gate 裁决、投影生成、Guard 检查、高信任调用均记录到 `.trust-proxy/audit/<sessionId>.ndjson`，可用 `trust-agent status` 查看。

### Canary 测试
在 secret 文件中植入唯一 token（`CANARY_xxxx`），运行后检测是否出现在云端 LLM 的输入消息中，验证隔离机制有效性。

---

## 架构

```
packages/
├── core/          # 核心库
│   └── src/
│       ├── asset/         # TrustPolicy 加载 + AssetMap（glob 匹配）
│       ├── projection/    # ProjectionEngine + 缓存
│       ├── guard/         # Guard（三层）+ CanaryTester
│       ├── gate/          # TrustGate + InfoBudgetTracker
│       ├── hightrust/     # HighTrustPool + Patcher + API 工具
│       ├── workspace/     # 双 workspace 隔离管理
│       ├── orchestrator/  # Orchestrator（LLM 主循环）+ 内建 tools
│       ├── audit/         # AuditLogger（NDJSON）
│       └── types.ts       # 全局类型定义
├── cli/           # 命令行入口
│   └── src/
│       ├── commands/
│       │   ├── init.ts    # trust-agent init
│       │   ├── run.ts     # trust-agent run
│       │   └── status.ts  # trust-agent status
│       └── index.ts
└── eval/          # 测试 + 评估
    ├── fixtures/  # 样本项目（含 secret 文件）
    └── src/       # 55 个测试用例
```

### 数据流

```
用户
 │  trust-agent run "修复支付模块"
 ▼
Orchestrator
 │  system prompt + 任务
 ▼
云端 LLM ──────────────────────── tool call ──────────────────────────►
                                                                        │
                                                               TrustGate.evaluate()
                                                                        │
                        ┌───────────────────────────────────────────────┤
                        │ PASS          │ PROXY_READ   │ PROXY_WRITE    │ REDACT
                        ▼               ▼               ▼               ▼
                   直接执行       ProjectionEngine    Patcher        grep结果
                                  L0/L1: 正则          备份→模型      过滤secret行
                                  L2/L3: 本地模型      生成→diff
                                        │               │
                                     Guard检查        Guard检查
                                  (三层过滤)          (摘要)
                                        │
                                   返回投影内容
                                        │
◄──────────────────────────────── tool result ────────────────────────────
云端 LLM 看到: 摘要/签名/行为描述   (永远看不到源码)
```

---

## 快速开始

### 前置条件

- [Bun](https://bun.sh) >= 1.0
- 云端 LLM API key（Anthropic 或 OpenAI）
- 本地模型服务（可选，处理 secret 文件）：任何 OpenAI-compatible API

### 安装

```bash
git clone https://github.com/microarch-flow/trust-agent.git
cd trust-agent
bun install
```

### 初始化项目

```bash
# 在你的项目目录下
cd /your/project
trust-agent init

# 或指定路径
trust-agent init /path/to/project
```

### 配置策略

编辑生成的 `.trust-policy.yml`：

```yaml
version: "1"

# 文件分类规则
assets:
  default: public
  rules:
    - pattern: "src/core/**"
      level: secret
      reason: 核心算法逻辑
    - pattern: "src/crypto/**"
      level: secret
      reason: 加密模块
  ignore:
    - "**/*.test.*"
    - "**/*.d.ts"

# 提供商定义（集中管理 API 端点，支持 ${ENV_VAR} 插值）
providers:
  anthropic:
    api: anthropic
    apiKey: ${ANTHROPIC_API_KEY}

  local:                                  # 支持 Ollama / vLLM / LMStudio / SGLang
    api: openai-compatible
    baseURL: http://localhost:11434/v1

# 模型角色分配（引用 providers 中的名称）
models:
  driver:                                 # 云端驱动模型（低信任）
    provider: anthropic
    model: claude-sonnet-4-20250514

  projector:                              # 生成 L2/L3 投影摘要
    provider: local
    model: qwen2.5-coder:1.5b

  answerer:                               # 回答 ask_high_trust 问题
    provider: local
    model: qwen2.5-coder:7b

  patcher:                               # 修改 secret 文件
    provider: local
    model: qwen2.5-coder:7b

# 安全配置
security:
  projection:
    default_level: 2                      # 0=stat 1=签名 2=行为摘要 3=伪代码
    budget:
      tokens_per_file: 4096
      ask_limit: 20
  guard:
    structure_fingerprint:
      similarity_threshold: 0.75         # 控制流结构相似度阈值
    meta_guard:
      enabled: true                      # 本地模型语义审查

# 工具与会话配置
tools:
  bash:
    policy: workspace_isolated           # workspace_isolated | unrestricted | disabled
session:
  max_iterations: 50
audit:
  log_dir: .trust-proxy/audit
  retention_days: 30
```

### 验证配置

```bash
# 检查配置文件语法、API key、模型配置
trust-agent validate

# 同时测试 API 连通性
trust-agent validate --check-connectivity
```

### 运行 Agent

```bash
# 使用配置文件中的模型（推荐）
trust-agent run "给 SchedulerEngine 添加超时重试逻辑"

# CLI 参数覆盖配置文件
trust-agent run "优化调度算法" --model gpt-4o --provider openai
trust-agent run "修复 bug" --api-key sk-xxx --base-url https://proxy.com/v1
```

### 查看审计日志

```bash
# 列出所有 session
trust-agent status

# 查看某个 session 的详细事件
trust-agent status <session-id>
```

---

## 构建可执行文件

```bash
cd packages/cli

# 构建当前平台二进制
bun run build

# 交叉编译所有平台（linux/darwin × x64/arm64）
bun run build:all
```

产物位于 `packages/cli/dist/`：

```
dist/
├── trust-agent-linux-x64/trust-agent
├── trust-agent-linux-arm64/trust-agent
├── trust-agent-darwin-x64/trust-agent
└── trust-agent-darwin-arm64/trust-agent
```

生成的是**独立可执行文件**，无需安装 Bun 或 Node.js，直接分发运行。

---

## 开发

### 运行测试

```bash
# 全部测试（55 个用例）
bun test

# 单独跑某个测试文件
bun test packages/eval/src/e2e.test.ts
bun test packages/eval/src/guard-layers.test.ts
```

测试覆盖：
- `e2e.test.ts` — 22 个：AssetMap、TrustGate 五种裁决、Projection L0-L3、Guard、Cache
- `e2e-real.test.ts` — 8 个：脚本化模拟 LLM 多步交互，验证 token 不泄漏
- `phase3.test.ts` — 12 个：双 workspace 隔离、PROXY_WRITE 流程、Canary
- `guard-layers.test.ts` — 13 个：三层 Guard（结构指纹、Meta-Guard、兼容性）

### 本地运行 CLI（无需构建）

```bash
bun run packages/cli/src/index.ts help
bun run packages/cli/src/index.ts init /your/project
bun run packages/cli/src/index.ts validate /your/project
bun run packages/cli/src/index.ts run "你的任务"
```

### 包结构

| 包 | 说明 |
|----|------|
| `@trust-proxy/core` | 核心库，零 CLI 依赖，可嵌入其他项目 |
| `@trust-proxy/cli` | 命令行工具，依赖 core |
| `packages/eval` | 测试 + 评估套件（私有） |

---

## 安全模型说明

### 什么可以安全使用云端 LLM
- 读取 `public` 文件（原文）
- 读取 `secret` 文件的 L0/L1 投影（文件大小、导出签名）
- 读取经 Guard 过滤的 L2/L3 投影（行为描述）
- `grep` 结果中 public 文件的匹配行
- `ask_high_trust` 回答（文字描述，经 Guard 检查）

### 什么永远不发送给云端 LLM
- `secret` 文件的源码
- 内部函数名、私有变量名
- 常量值、密钥、算法权重
- 任何 Guard 三层检测未通过的内容

### 已知局限
- Guard Layer 2/3 依赖本地模型，若未配置则退化为仅 Layer 1
- Patcher 生成代码质量取决于本地模型能力
- 极端情况下（模型主动对抗）Meta-Guard 仍可能被绕过

---

## License

MIT
