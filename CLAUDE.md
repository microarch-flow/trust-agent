# Trust Proxy — CLAUDE.md

## 项目背景

**问题**：Cursor/Claude Code/Copilot 等 AI 编码工具把源码发给云端 LLM，包含核心算法、专有业务逻辑、加密实现的代码不适合走这条路。

**方案**：双模型双信任域。云端强模型（低信任）驱动任务，只看 public 文件原文和 secret 文件的"投影摘要"；本地小模型（高信任）守护 secret 文件，负责生成投影、回答问题、执行修改。Secret 文件源码永不离开本地。

**当前状态**：Sprint 6 完成（v0.1.0 基础能力），Sprint 7 进行中（链路稳定性）。原型完成度 ~60%，产品完成度 ~20%。

---

## 架构

```
用户任务
  ↓
Orchestrator（驱动 LLM loop）
  ↓ 每次 tool call
Trust Gate（拦截 + 裁决）
  ├── PASS       → 工具直接执行（public 文件）
  ├── PROXY_READ → Projector 生成投影 → Guard 检查 → 返回摘要
  ├── PROXY_WRITE→ Patcher 读原文执行 intent → Guard 检查 → 返回结果
  ├── REDACT     → 工具执行后裁剪输出（grep 结果中 secret 行替换为计数）
  └── DENY       → 拒绝（预算耗尽 / 注入检测）
```

**投影四级**（secret 文件不发原文，发投影）：
- L0 文件存在性（stat，毫秒）
- L1 函数签名/类型（tree-sitter，毫秒）
- L2 行为描述（本地模型，0.5-2s）
- L3 伪代码（本地较大模型，2-5s）

**Guard 三层**：L1 token 匹配、L2 trigram 结构指纹、L3 Meta-Guard 小模型语义审查

**双 Workspace**：`workspace-public/`（LLM 工作区，secret 文件替换为投影文本）+ `workspace-real/`（含原文，仅高信任访问）

---

## 代码组织

```
packages/
├── core/src/                    # 核心库
│   ├── types.ts                 # 全局类型定义（GateVerdict、ProjectionResult、TrustConfig 等）
│   ├── asset/policy.ts          # AssetMap：加载 .trust-policy.yml，文件分级（secret/derived/public）
│   ├── gate/
│   │   ├── gate.ts              # TrustGate：核心拦截器，五种裁决路由
│   │   └── budget.ts            # InfoBudgetTracker：信息预算（token 上限、ask 次数）
│   ├── projection/
│   │   ├── engine.ts            # ProjectionEngine：L0-L3 投影生成（stat/tree-sitter/model）
│   │   └── cache.ts             # ProjectionCache：source hash 驱动的缓存失效
│   ├── guard/
│   │   ├── guard.ts             # Guard：三层检测（token match + trigram + meta-guard）
│   │   ├── canary.ts            # CanaryManager：植入唯一 token，session 结束验证是否泄漏
│   │   └── injection.ts        # 注入检测：prompt injection + intent injection
│   ├── hightrust/
│   │   ├── pool.ts              # HighTrustPool：路由到 Projector/Answerer/Patcher
│   │   ├── patcher.ts           # Patcher：接收 intent，在真实源码上生成 diff
│   │   └── api.ts               # 本地模型 API 调用（OpenAI-compatible endpoint）
│   ├── orchestrator/
│   │   ├── orchestrator.ts      # Orchestrator：LLM loop 主循环，session 管理
│   │   └── tools.ts             # 工具定义（read_file/write_file/edit_file/bash/grep/glob/ask_high_trust）
│   ├── workspace/manager.ts     # WorkspaceManager：双 workspace 创建与同步
│   └── audit/logger.ts          # AuditLogger：结构化审计日志（NDJSON）
│
├── cli/src/                     # CLI 层
│   ├── index.ts                 # 入口，注册子命令
│   ├── reporter.ts              # CliReporter：实时格式化输出（PASS/PROXY/GUARD 事件）
│   └── commands/
│       ├── init.ts              # trust-agent init：扫描项目，生成 .trust-policy.yml
│       ├── run.ts               # trust-agent run：执行编码任务
│       ├── status.ts            # trust-agent status：查看 session 审计摘要
│       ├── validate.ts          # trust-agent validate：检查配置、测试投影
│       └── serve.ts             # trust-agent serve：MCP server 模式
│
├── eval/src/                    # 测试套件
│   ├── regression.test.ts       # 回归测试（只读/单文件写/多文件重构）
│   ├── e2e.test.ts              # 端到端测试（mock LLM）
│   ├── e2e-real.test.ts         # 真实 LLM 端到端测试
│   ├── guard-layers.test.ts     # Guard 三层单元测试
│   ├── redteam.test.ts          # 红队攻击场景测试
│   ├── behavior.test.ts         # Agent 行为测试（planning、原子操作）
│   ├── observability.test.ts    # 可观测性测试
│   └── fixtures/sample-project/ # 测试用 secret/public 项目样本
│
└── examples/                    # 示例项目（ts-only / python / mixed）
```

---

## 关键配置

`.trust-policy.yml`（放在项目根目录）：

```yaml
default: public
secret:
  - src/core/crypto/**
  - src/algo/proprietary-*
derived:
  - src/api/wrapper.ts
models:
  driver:                        # 云端低信任模型
    provider: anthropic
    model: claude-sonnet-4-5
  high_trust:                    # 本地高信任模型（OpenAI-compatible）
    base_url: http://localhost:11434/v1
    model: qwen2.5-coder:7b
security:
  projection:
    default_level: 2
    budget:
      tokens_per_file: 4096
      ask_limit: 20
```

---

## 开发常用命令

```bash
bun test                              # 跑所有测试
bun test packages/eval/src/guard-layers.test.ts  # 跑单个测试文件
bun run build                         # 编译 TypeScript

trust-agent init                      # 初始化项目
trust-agent validate --check-connectivity  # 检查模型连通性
trust-agent validate --test-projection <file>  # 打印文件四级投影
trust-agent run "任务描述"             # 执行编码任务
trust-agent status                    # 查看最近 session 摘要
```

---

## 当前重点（Sprint 7）

优先顺序：真实 session 测试 → C++ L1 投影 → token 精确计数 → 工具异常捕获 → git stash 集成 → Guard AST 升级 → 投影质量评估

详见 `doc/sprint7-todo.md` 和 `doc/next-phase-todo.md`。
