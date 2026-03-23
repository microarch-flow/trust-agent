# 02 — Trust Gate 详细设计

## 1. 职责

Trust Gate 是整个系统的安全核心。它拦截 low-trust LLM 发出的每一次 tool call，判定该调用是否涉及 secret 资产，并决定如何处理。

Trust Gate 的设计原则：
- **默认放行**：不涉及 secret 的操作零额外开销
- **拦截即路由**：涉及 secret 时不是简单拒绝，而是路由到 high-trust 代理
- **可审计**：每次判定都写入 audit log
- **fail-closed**：异常时拒绝而非放行

## 2. 核心类型

```typescript
// --- 敏感级别 ---
type AssetLevel = "secret" | "derived" | "public"

// --- Trust Gate 判定结果 ---
type GateVerdict =
  | { action: "PASS" }                                    // 直接放行
  | { action: "PROXY_READ"; file: string; level: ProjectionLevel }  // 代理读
  | { action: "PROXY_WRITE"; file: string; intent: string }         // 代理写
  | { action: "REDACT"; redactions: Redaction[] }                   // 执行后裁剪
  | { action: "DENY"; reason: string }                              // 拒绝

type Redaction = {
  file: string           // 被 redact 的文件路径
  matches: number        // 原始匹配数（告诉 LLM 这里有内容被裁掉了）
}

type ProjectionLevel = 0 | 1 | 2 | 3

// --- Gate 上下文 ---
type GateContext = {
  sessionId: string
  toolName: string
  toolArgs: Record<string, unknown>
  assetMap: AssetMap
  projectionCache: ProjectionCache
  infoBudget: InfoBudgetTracker
}

// --- 审计事件 ---
type GateAuditEvent = {
  timestamp: string
  sessionId: string
  toolName: string
  toolArgs: Record<string, unknown>   // 注意：secret 文件路径可以记录，内容不记录
  verdict: GateVerdict
  durationMs: number
}
```

## 3. 判定逻辑

### 3.1 主判定流程

```typescript
async function evaluate(ctx: GateContext): Promise<GateVerdict> {
  const { toolName, toolArgs, assetMap } = ctx

  switch (toolName) {
    case "read":
      return evaluateRead(toolArgs.path as string, ctx)
    case "edit":
    case "write":
      return evaluateWrite(toolArgs.path as string, toolArgs, ctx)
    case "grep":
      return evaluateGrep(toolArgs, ctx)
    case "glob":
      return { action: "PASS" }  // 文件名列表不敏感
    case "bash":
      return { action: "PASS" }  // 双 workspace 已隔离，bash 在 public ws 中执行
    case "ask_high_trust":
      return evaluateAskHighTrust(toolArgs, ctx)
    default:
      return { action: "PASS" }
  }
}
```

### 3.2 Read 判定

```typescript
async function evaluateRead(filePath: string, ctx: GateContext): Promise<GateVerdict> {
  const level = ctx.assetMap.getLevel(filePath)

  if (level === "public") {
    return { action: "PASS" }
  }

  // secret 或 derived → 需要投影
  const budgetOk = ctx.infoBudget.canProject(filePath, ctx.sessionId)
  if (!budgetOk) {
    return {
      action: "DENY",
      reason: `信息预算已耗尽: ${filePath}。建议切换到 high-trust 全本地模式。`
    }
  }

  // 确定投影级别
  const projLevel = ctx.infoBudget.currentLevel(filePath, ctx.sessionId)

  return {
    action: "PROXY_READ",
    file: filePath,
    level: projLevel
  }
}
```

### 3.3 Write/Edit 判定

```typescript
async function evaluateWrite(
  filePath: string,
  toolArgs: Record<string, unknown>,
  ctx: GateContext
): Promise<GateVerdict> {
  const level = ctx.assetMap.getLevel(filePath)

  if (level === "public") {
    return { action: "PASS" }
  }

  // secret 文件 → 转为 intent
  // LLM 没见过原文，所以它的 edit 参数不是精确的 old_string/new_string
  // 而是 intent 描述
  const intent = extractIntent(toolArgs)

  return {
    action: "PROXY_WRITE",
    file: filePath,
    intent
  }
}

function extractIntent(toolArgs: Record<string, unknown>): string {
  // 如果 LLM 调的是 edit(file, old_string, new_string)
  // 把 old_string + new_string 当作 intent 描述
  // 如果 LLM 调的是 ask_high_trust + edit intent
  // 直接取 intent 字段
  if (toolArgs.intent) return toolArgs.intent as string
  return `修改意图: 将 "${toolArgs.old_string}" 改为 "${toolArgs.new_string}"`
}
```

### 3.4 Grep 判定

```typescript
async function evaluateGrep(
  toolArgs: Record<string, unknown>,
  ctx: GateContext
): Promise<GateVerdict> {
  // grep 先执行，然后对结果做裁剪
  // 不能预先判定，因为不知道哪些文件会匹配
  // 所以 verdict 是 REDACT，由 tool 执行后处理
  return {
    action: "REDACT",
    redactions: []  // 执行后填充
  }
}
```

### 3.5 Grep 结果裁剪

```typescript
function redactGrepResults(
  results: GrepResult[],
  assetMap: AssetMap
): { output: string; redactions: Redaction[] } {
  const lines: string[] = []
  const redactions: Redaction[] = []

  // 按文件分组
  const byFile = groupBy(results, r => r.file)

  for (const [file, matches] of Object.entries(byFile)) {
    const level = assetMap.getLevel(file)

    if (level === "public") {
      // 放行，原样输出
      for (const m of matches) {
        lines.push(`${file}:${m.line}: ${m.content}`)
      }
    } else {
      // secret/derived → 只输出匹配计数
      lines.push(`${file}: [REDACTED - ${matches.length} match(es) in secret file]`)
      redactions.push({ file, matches: matches.length })
    }
  }

  return { output: lines.join("\n"), redactions }
}
```

## 4. Tool 包装

Trust Gate 不直接修改原始 tool 的实现，而是在 tool 外层包装一个拦截器。

```typescript
type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>   // JSON Schema
  execute: (args: Record<string, unknown>) => Promise<ToolResult>
}

type ToolResult = {
  output: string
  metadata?: Record<string, unknown>
}

// Trust Gate 包装器
function wrapTool(tool: ToolDefinition, gate: TrustGate): ToolDefinition {
  return {
    ...tool,
    execute: async (args) => {
      const verdict = await gate.evaluate({
        toolName: tool.name,
        toolArgs: args,
        // ... context
      })

      switch (verdict.action) {
        case "PASS":
          return tool.execute(args)

        case "PROXY_READ":
          return gate.proxyRead(verdict.file, verdict.level)

        case "PROXY_WRITE":
          return gate.proxyWrite(verdict.file, verdict.intent)

        case "REDACT": {
          const result = await tool.execute(args)
          return gate.redactOutput(result, args)
        }

        case "DENY":
          return { output: `[DENIED] ${verdict.reason}` }
      }
    }
  }
}
```

## 5. ask_high_trust Tool

这是新增的 tool，注册到 LLM 可用的 tool 列表中：

```typescript
const askHighTrustTool: ToolDefinition = {
  name: "ask_high_trust",
  description: `向安全域提问关于 secret 文件的具体问题。
当你需要了解 secret 文件的内部行为、边界条件或实现细节时使用此工具。
回答将是文本描述，不包含源码。`,
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "关于 secret 文件的具体问题"
      },
      files: {
        type: "array",
        items: { type: "string" },
        description: "相关的 secret 文件路径"
      },
      context: {
        type: "string",
        description: "为什么需要这个信息（帮助安全域给出更相关的回答）"
      }
    },
    required: ["question", "files"]
  },
  execute: async (args) => {
    // 由 Trust Gate 路由到 Answerer
    // 见 high-trust-pool-design.md
  }
}
```

## 6. Asset Map

### 6.1 配置格式

```yaml
# .trust-policy.yml
default: public

secret:
  - src/core/crypto/**
  - src/core/engine/scheduler.cpp
  - src/algo/proprietary-*

derived:
  - src/context/**

ignore:                           # 即使匹配 secret 也视为 public
  - "**/types.h"
  - "**/interface.h"
  - "**/*_test.cpp"
  - "**/*.test.ts"

settings:
  default_projection_level: 2     # 默认投影级别
  max_projection_level: 3         # 允许的最高级别
  info_budget_ceiling: 4096       # 每文件每 session token 上限
  ask_limit: 10                   # 每 session ask_high_trust 次数上限
```

### 6.2 解析逻辑

```typescript
type AssetMap = {
  getLevel(filePath: string): AssetLevel
  listSecretFiles(): string[]
  listDerivedFiles(): string[]
  getSettings(): PolicySettings
}

function loadAssetMap(policyPath: string, projectRoot: string): AssetMap {
  const policy = parseYaml(readFile(policyPath))

  return {
    getLevel(filePath: string): AssetLevel {
      const rel = relative(projectRoot, filePath)

      // ignore 优先级最高
      if (matchesAny(rel, policy.ignore)) return "public"
      // 然后 secret
      if (matchesAny(rel, policy.secret)) return "secret"
      // 然后 derived
      if (matchesAny(rel, policy.derived)) return "derived"
      // 默认
      return policy.default || "public"
    },
    // ...
  }
}
```

## 7. 异常处理

| 异常场景 | 处理方式 |
|---------|---------|
| `.trust-policy.yml` 不存在 | 所有文件视为 public，提示用户运行 `trust-agent init` |
| Asset Map 解析失败 | 拒绝启动，报错 |
| Projection Engine 不可用 | PROXY_READ → DENY（给出原因），不 fallback 到暴露原文 |
| Patcher 不可用 | PROXY_WRITE → DENY（给出原因） |
| Guard 检查未通过 | 降级到更低 projection level 重试，三次失败后 DENY |
| 信息预算耗尽 | DENY + 提示切换到 high-trust 模式 |
| tool call 超时 | 返回超时错误，不泄露部分结果 |

核心原则：**任何异常都不应导致 secret 文件原文被发送给 cloud LLM。**
