# 01 — 系统架构

## 1. 架构总图

```
┌─────────────────────────────────────────────────────────────────┐
│                          CLI Layer                               │
│  trust-agent init / trust-agent run / trust-agent status         │
└───────────────────────────┬─────────────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────────────┐
│                      Orchestrator                                │
│                                                                  │
│  负责：                                                          │
│    - 接收用户任务                                                 │
│    - 创建 session                                                │
│    - 驱动 LLM loop（prompt → tool call → result → prompt...）    │
│    - 任务完成后输出结果和审计摘要                                   │
└───────────────────────────┬─────────────────────────────────────┘
                            │
                            │ 每次 tool call
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Trust Gate                                 │
│                                                                  │
│  输入：tool_name, tool_args, session_context                     │
│  输出：GateVerdict (PASS / PROXY_READ / PROXY_WRITE /            │
│                     REDACT / DENY)                               │
│                                                                  │
│  依赖：                                                          │
│    ← Asset Map（文件 → 敏感级别映射）                              │
│    ← Projection Cache（已生成的投影缓存）                          │
│    ← Info Budget（信息预算跟踪）                                   │
│    → Audit Log（每次判定写审计事件）                                │
└──────┬──────────────┬──────────────┬────────────────────────────┘
       │              │              │
       │ PASS         │ PROXY_*      │ REDACT
       ▼              ▼              ▼
┌────────────┐ ┌────────────┐ ┌────────────┐
│ Tool       │ │ High-Trust │ │ Tool       │
│ 直接执行    │ │ Agent Pool │ │ 执行后裁剪  │
│            │ │            │ │            │
│ 在 public  │ │ Projector  │ │ grep 结果   │
│ workspace  │ │ Answerer   │ │ 中 secret   │
│ 中操作     │ │ Patcher    │ │ 行被替换    │
│            │ │ Guard      │ │            │
└────────────┘ └────────────┘ └────────────┘
                     │
                     ▼
              ┌────────────┐
              │ Real       │
              │ Workspace  │
              │ (secret    │
              │  原文)      │
              └────────────┘
```

## 2. 核心组件

### 2.1 组件清单

| 组件 | 职责 | 实施阶段 |
|------|------|---------|
| **CLI** | 用户入口：init / run / status / audit | P1-P4 |
| **Orchestrator** | 创建 session、驱动 LLM loop、管理生命周期 | P1 |
| **Trust Gate** | 拦截 tool call、判定 verdict、路由到 high-trust 或直接执行 | P1 |
| **Asset Map** | 加载 `.trust-policy.yml`，解析文件→敏感级别映射 | P1 |
| **Projection Cache** | 缓存 projection 结果，hash 失效 | P1 |
| **Projection Engine** | 生成各级别 projection（tree-sitter + 模型） | P1-P2 |
| **High-Trust Router** | 按任务类型路由到 Projector/Answerer/Patcher | P2 |
| **Projector** | 本地小模型，读源码→生成结构化投影 | P2 |
| **Answerer** | 本地中模型，回答关于 secret 文件的问题 | P3 |
| **Patcher** | 本地中模型，收 intent→在真实代码上生成 diff | P3 |
| **Guard** | 检查输出是否泄露 secret 信息 | P1（规则），P2（模型） |
| **Info Budget** | 跟踪每 session 每文件的信息发送量 | P3 |
| **Dual Workspace** | 维护 public/real 双工作区及同步 | P3 |
| **Audit Log** | 结构化审计事件记录 | P1 |
| **Dashboard** | CLI 运行时安全仪表盘 | P4 |

### 2.2 组件交互图

```
                    ┌──────────┐
                    │   CLI    │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │Orchestr- │──→ LLM Provider (cloud)
                    │  ator    │←── stream response
                    └────┬─────┘
                         │ tool call
                    ┌────▼─────┐     ┌───────────┐
                    │  Trust   │────→│ Asset Map │
                    │  Gate    │←────│           │
                    └──┬─┬─┬──┘     └───────────┘
                       │ │ │
          ┌────────────┘ │ └────────────┐
          ▼              ▼              ▼
    ┌──────────┐  ┌───────────┐  ┌──────────┐
    │   Tool   │  │High-Trust │  │  Tool    │
    │  (PASS)  │  │  Router   │  │ (REDACT) │
    └──────────┘  └─┬──┬──┬──┘  └──────────┘
                    │  │  │
         ┌──────────┘  │  └──────────┐
         ▼             ▼             ▼
    ┌─────────┐  ┌──────────┐  ┌─────────┐
    │Projector│  │ Answerer │  │ Patcher │
    └────┬────┘  └────┬─────┘  └────┬────┘
         │            │             │
         └────────────┼─────────────┘
                      ▼
                ┌──────────┐     ┌───────────┐
                │  Guard   │────→│ Audit Log │
                └──────────┘     └───────────┘
```

## 3. 数据流

### 3.1 正常路径（public 文件）

```
用户: "给 tests/test-foo.cpp 添加一个测试用例"
  → Orchestrator 发 prompt 给 cloud LLM
  → LLM 调 read("tests/test-foo.cpp")
  → Trust Gate: public → PASS
  → 直接读 public workspace → 返回原文
  → LLM 调 edit("tests/test-foo.cpp", ...)
  → Trust Gate: public → PASS
  → 直接执行编辑
  → LLM: "done"

高信任调用次数: 0
额外延迟: 0
```

### 3.2 读取路径（secret 文件）

```
LLM 调 read("src/core/crypto/aes.cpp")
  → Trust Gate 查 Asset Map → secret
  → Trust Gate 查 Projection Cache
    → miss: 调 Projection Engine
      → Level 1: tree-sitter 提取签名（毫秒）
      → Level 2: 调 Projector 模型（0.5-2s）
      → Guard 检查 projection
      → 写入 cache
    → hit: 直接取缓存
  → 返回 projection 给 LLM
  → Audit Log 记录事件
```

### 3.3 写入路径（secret 文件）

```
LLM 调 edit("src/core/crypto/aes.cpp", intent_description)
  → Trust Gate 查 Asset Map → secret → PROXY_WRITE
  → 打包 EditIntent {file, intent, context}
  → High-Trust Router → Patcher
  → Patcher 读 real workspace 原文
  → Patcher 生成 diff
  → Guard 检查 diff（不应该把 secret 内容放到 public 文件）
  → 应用 diff 到 real workspace
  → 使 projection cache 失效
  → 同步更新 public workspace 中对应的 projection 文件
  → 返回 "edit applied, N lines changed"
  → Audit Log 记录 intent + actual diff
```

## 4. 目录结构

```
trust-proxy/
├── packages/
│   ├── core/                    # 核心库
│   │   ├── src/
│   │   │   ├── gate/            # Trust Gate
│   │   │   │   ├── gate.ts          # 主判定逻辑
│   │   │   │   ├── verdict.ts       # GateVerdict 类型
│   │   │   │   └── interceptors/    # 每种 tool 的拦截器
│   │   │   │       ├── read.ts
│   │   │   │       ├── edit.ts
│   │   │   │       ├── grep.ts
│   │   │   │       └── bash.ts
│   │   │   ├── asset/           # Asset Map
│   │   │   │   ├── policy.ts        # .trust-policy.yml 加载解析
│   │   │   │   ├── matcher.ts       # glob 匹配
│   │   │   │   └── types.ts         # AssetLevel, TrustTier 等
│   │   │   ├── projection/      # Projection 系统
│   │   │   │   ├── engine.ts        # Projection Engine 主入口
│   │   │   │   ├── cache.ts         # Projection Cache
│   │   │   │   ├── treesitter.ts    # Level 0-1 静态提取
│   │   │   │   ├── model.ts         # Level 2-3 模型调用
│   │   │   │   └── schema.ts        # Projection JSON schema
│   │   │   ├── guard/           # Guard 系统
│   │   │   │   ├── guard.ts         # Guard 主逻辑
│   │   │   │   ├── token.ts         # token 提取和匹配
│   │   │   │   ├── canary.ts        # canary 测试
│   │   │   │   └── budget.ts        # 信息预算
│   │   │   ├── workspace/       # 双 Workspace
│   │   │   │   ├── manager.ts       # workspace 生命周期
│   │   │   │   ├── sync.ts          # public ↔ real 同步
│   │   │   │   └── projection-fs.ts # projection 文件生成
│   │   │   ├── hightrust/       # High-Trust Agent Pool
│   │   │   │   ├── router.ts        # 任务路由
│   │   │   │   ├── projector.ts     # Projector 调用
│   │   │   │   ├── answerer.ts      # Answerer 调用
│   │   │   │   ├── patcher.ts       # Patcher 调用
│   │   │   │   └── model-manager.ts # 本地模型生命周期
│   │   │   ├── orchestrator/    # Orchestrator
│   │   │   │   ├── orchestrator.ts  # 主编排
│   │   │   │   ├── session.ts       # Session 管理
│   │   │   │   ├── loop.ts          # LLM tool loop
│   │   │   │   └── tools.ts         # Tool 注册和包装
│   │   │   ├── audit/           # 审计
│   │   │   │   ├── logger.ts        # 事件记录
│   │   │   │   ├── types.ts         # 事件类型
│   │   │   │   └── report.ts        # 摘要生成
│   │   │   └── types.ts         # 全局共享类型
│   │   └── package.json
│   ├── cli/                     # CLI 工具
│   │   ├── src/
│   │   │   ├── commands/
│   │   │   │   ├── init.ts
│   │   │   │   ├── run.ts
│   │   │   │   ├── status.ts
│   │   │   │   ├── audit.ts
│   │   │   │   └── canary.ts
│   │   │   ├── dashboard.ts     # 运行时仪表盘
│   │   │   └── index.ts
│   │   └── package.json
│   └── eval/                    # 评估工具（benchmark）
│       ├── src/
│       │   ├── benchmark.ts
│       │   ├── datasets/
│       │   └── metrics.ts
│       └── package.json
├── models/                      # 模型相关
│   ├── training/                # 微调脚本 (Python)
│   │   ├── projector/
│   │   ├── answerer/
│   │   └── patcher/
│   └── eval/                    # 模型评估 (Python)
├── .trust-policy.yml.example    # 示例配置
├── package.json                 # monorepo root
└── tsconfig.json
```

## 5. 技术选型

| 组件 | 技术 | 理由 |
|------|------|------|
| 语言 | TypeScript (Bun runtime) | AI 工具链主流，opencode 可参考 |
| Monorepo | pnpm workspace 或 Bun workspace | 多包管理 |
| LLM 调用 | Vercel AI SDK (`ai` package) | 多 provider 统一接口，opencode 已验证 |
| AST 解析 | tree-sitter (wasm binding) | 跨语言 AST，Level 0-1 projection |
| 本地模型 | Ollama HTTP API | 最简单的本地模型管理 |
| CLI 框架 | Commander.js 或 clipanion | 轻量 CLI |
| 配置解析 | yaml (js-yaml) | .trust-policy.yml |
| 文件监听 | chokidar 或 fs.watch | workspace 同步 |
| 测试 | Bun test 或 vitest | 单元/集成测试 |

## 6. 外部依赖

| 依赖 | 用途 | 是否必须 |
|------|------|---------|
| Cloud LLM API (Claude/GPT/等) | Low-trust agent 的推理引擎 | 是 |
| Ollama | 本地模型推理服务 | Phase 2 起必须 |
| tree-sitter + 语言 grammar | AST 提取 | Phase 1 起必须（L0-1） |
| Git | workspace 管理、文件 hash | 是 |
