# 06 — Guard 系统设计

## 1. 职责

Guard 系统有三个职责：
1. **输出检查**：检查 Projector/Answerer/Patcher 的输出是否泄露 secret 信息
2. **Canary 测试**：提供可量化的安全验证
3. **信息预算**：控制每 session 发送给 cloud LLM 的 secret 相关信息总量

## 2. 输出检查

### 2.1 检查管道

```typescript
type GuardInput = {
  content: string                  // 要检查的内容
  sourceFiles: string[]            // 这些 secret 文件是信息来源
  contentType: "projection" | "answer" | "patch_diff"
}

type GuardResult = {
  passed: boolean
  violations: Violation[]
  checkedAt: string
  durationMs: number
}

type Violation = {
  type: "token_leak" | "line_leak" | "code_block_leak" | "schema_invalid"
  detail: string                   // 泄露了什么（token 名 / 行号 / 描述）
  severity: "high" | "medium" | "low"
}
```

### 2.2 检查规则

```typescript
async function checkGuard(input: GuardInput): Promise<GuardResult> {
  const violations: Violation[] = []

  // ---- Rule 1: Token 匹配 ----
  // 从 secret 源文件中提取"内部标识符"
  // 这些标识符只出现在 secret 文件中，不出现在 public 文件中
  const internalTokens = await extractInternalTokens(input.sourceFiles)
  for (const token of internalTokens) {
    if (input.content.includes(token)) {
      violations.push({
        type: "token_leak",
        detail: token,
        severity: "high"
      })
    }
  }

  // ---- Rule 2: 行匹配 ----
  // 检查 secret 文件中的完整行是否出现在输出中
  for (const file of input.sourceFiles) {
    const sourceLines = (await readFile(file, "utf-8")).split("\n")
    for (let i = 0; i < sourceLines.length; i++) {
      const line = sourceLines[i].trim()
      if (line.length < 24) continue     // 太短的行忽略（通用代码）
      if (isBoilerplate(line)) continue   // #include, using, import 等忽略
      if (input.content.includes(line)) {
        violations.push({
          type: "line_leak",
          detail: `Line ${i + 1}: ${line.slice(0, 60)}...`,
          severity: "high"
        })
      }
    }
  }

  // ---- Rule 3: 代码块检测 ----
  // 检查输出中是否有连续 3+ 行与源码匹配
  const codeBlocks = extractCodeBlocks(input.content)
  for (const block of codeBlocks) {
    const matchScore = fuzzyMatchScore(block, input.sourceFiles)
    if (matchScore > 0.8) {
      violations.push({
        type: "code_block_leak",
        detail: `Code block of ${block.split("\n").length} lines matches source`,
        severity: "high"
      })
    }
  }

  // ---- Rule 4: Schema 校验（仅对 projection）----
  if (input.contentType === "projection") {
    try {
      const parsed = JSON.parse(input.content)
      const valid = validateProjectionSchema(parsed)
      if (!valid) {
        violations.push({
          type: "schema_invalid",
          detail: "Projection output does not match expected schema",
          severity: "medium"
        })
      }
    } catch {
      violations.push({
        type: "schema_invalid",
        detail: "Projection output is not valid JSON",
        severity: "medium"
      })
    }
  }

  return {
    passed: violations.filter(v => v.severity === "high").length === 0,
    violations,
    checkedAt: new Date().toISOString(),
    durationMs: 0, // 填入实际值
  }
}
```

### 2.3 内部标识符提取

```typescript
async function extractInternalTokens(secretFiles: string[]): Promise<Set<string>> {
  // 1. 从所有 public 文件中收集已知 token
  const publicTokens = new Set<string>()
  const publicFiles = assetMap.listPublicFiles()
  for (const file of publicFiles) {
    const src = await readFile(file, "utf-8")
    for (const token of extractIdentifiers(src)) {
      publicTokens.add(token)
    }
  }

  // 2. 从 secret 文件中提取 token，减去 public token
  const internalTokens = new Set<string>()
  for (const file of secretFiles) {
    const src = await readFile(file, "utf-8")
    for (const token of extractIdentifiers(src)) {
      if (!publicTokens.has(token) && !isCommonWord(token)) {
        internalTokens.add(token)
      }
    }
  }

  // 3. 加上 .trust-policy.yml 中配置的 known_safe_tokens
  const safeTokens = assetMap.getSettings().known_safe_tokens || []
  for (const token of safeTokens) {
    internalTokens.delete(token)
  }

  return internalTokens
}

function extractIdentifiers(source: string): string[] {
  // 提取 7+ 字符的标识符
  return [...new Set(source.match(/\b[A-Za-z_][A-Za-z0-9_]{6,}\b/g) || [])]
    .filter(id => /[_\d]/.test(id) || /[A-Z]/.test(id))  // 排除纯小写单词
}
```

## 3. Canary 测试

### 3.1 原理

在 secret 文件中植入唯一的、不可能在正常代码中出现的标识符。运行完整的 coding 任务后，检查所有发给 cloud LLM 的数据中是否出现这些标识符。

### 3.2 实现

```typescript
type CanaryConfig = {
  prefix: string         // e.g., "CANARY_"
  count: number          // 每个 secret 文件植入几个
  length: number         // canary token 长度
}

// 植入 canary
async function plantCanaries(
  secretFiles: string[],
  config: CanaryConfig
): Promise<CanaryManifest> {
  const manifest: CanaryManifest = { canaries: [] }

  for (const file of secretFiles) {
    const source = await readFile(file, "utf-8")
    const lines = source.split("\n")

    for (let i = 0; i < config.count; i++) {
      const token = `${config.prefix}${randomHex(config.length)}`
      // 在随机位置插入注释形式的 canary
      const lineNo = randomInt(0, lines.length)
      const lang = detectLanguage(file)
      const comment = lang === "python" ? `# ${token}` : `// ${token}`
      lines.splice(lineNo, 0, comment)

      manifest.canaries.push({
        token,
        file,
        line: lineNo,
      })
    }

    await writeFile(file, lines.join("\n"))
  }

  return manifest
}

// 检测 canary 泄露
async function checkCanaries(
  manifest: CanaryManifest,
  auditLog: AuditEvent[]
): Promise<CanaryTestResult> {
  const leaked: string[] = []
  const safe: string[] = []

  // 收集所有发给 cloud LLM 的内容
  const cloudBound = auditLog
    .filter(e => e.direction === "to_cloud")
    .map(e => e.content)
    .join("\n")

  for (const canary of manifest.canaries) {
    if (cloudBound.includes(canary.token)) {
      leaked.push(canary.token)
    } else {
      safe.push(canary.token)
    }
  }

  return {
    passed: leaked.length === 0,
    total: manifest.canaries.length,
    leaked: leaked.length,
    safe: safe.length,
    leakedTokens: leaked,
  }
}
```

### 3.3 CLI 命令

```bash
# 运行 canary 测试
trust-agent canary --task "重构 slot 管理模块" --count 5

# 流程：
# 1. 备份 secret 文件
# 2. 植入 canary
# 3. 运行完整的 coding 任务
# 4. 检查 audit log 中是否有 canary
# 5. 恢复 secret 文件（移除 canary）
# 6. 输出报告
```

## 4. 信息预算

### 4.1 数据结构

```typescript
type InfoBudget = {
  sessionId: string
  entries: Map<string, FileBudget>   // filePath → budget
  globalAskCount: number             // 全 session 的 ask_high_trust 计数
  globalAskLimit: number             // 上限
}

type FileBudget = {
  filePath: string
  currentLevel: ProjectionLevel      // 当前已发送的最高 level
  maxLevel: ProjectionLevel          // 允许的最高 level
  tokensSent: number                 // 已发送的 projection token 总量
  tokenCeiling: number               // token 上限
  queryCount: number                 // 对此文件的追问次数
  queryLimit: number                 // 追问上限
}
```

### 4.2 预算检查

```typescript
interface InfoBudgetTracker {
  // 检查是否还能对该文件生成 projection
  canProject(filePath: string, sessionId: string): boolean

  // 获取该文件当前应该使用的 projection level
  currentLevel(filePath: string, sessionId: string): ProjectionLevel

  // 记录一次 projection 发送
  recordProjection(filePath: string, sessionId: string, level: ProjectionLevel, tokens: number): void

  // 记录一次 ask_high_trust
  recordAsk(sessionId: string): boolean   // 返回 false 表示超限

  // 获取预算摘要（用于仪表盘）
  summary(sessionId: string): BudgetSummary
}
```

### 4.3 预算策略

```
默认策略（可在 .trust-policy.yml 中覆盖）：

  per_file:
    token_ceiling: 4096    # 每文件每 session 最多发送 4096 token 的 projection
    max_level: 2           # 默认最高到 Level 2
    query_limit: 5         # 每文件最多追问 5 次

  per_session:
    ask_limit: 20          # 每 session 最多 20 次 ask_high_trust
    total_token_ceiling: 32768  # 所有 secret 文件的 projection token 总和上限

预算耗尽时的行为：
  → Trust Gate 返回 DENY
  → 消息："信息预算已耗尽。建议：
     1. 切换到 high-trust 全本地模式继续此任务
     2. 开始新 session（预算重置）
     3. 调整 .trust-policy.yml 中的预算配置"
```

## 5. 审计日志

### 5.1 事件类型

```typescript
type AuditEvent =
  | GateEvent           // Trust Gate 判定
  | ProjectionEvent     // Projection 生成
  | GuardEvent          // Guard 检查结果
  | HighTrustCallEvent  // High-trust 模型调用
  | BudgetEvent         // 信息预算变更
  | PatchEvent          // Patcher 应用修改

type GateEvent = {
  type: "gate"
  timestamp: string
  sessionId: string
  toolName: string
  filePath?: string
  verdict: string      // "PASS" | "PROXY_READ" | "PROXY_WRITE" | "REDACT" | "DENY"
  reason?: string
}

type ProjectionEvent = {
  type: "projection"
  timestamp: string
  sessionId: string
  filePath: string
  level: ProjectionLevel
  tokenCount: number
  source: "cache" | "treesitter" | "model"
  guardPassed: boolean
}

type HighTrustCallEvent = {
  type: "hightrust_call"
  timestamp: string
  sessionId: string
  model: string          // "projector" | "answerer" | "patcher"
  filePath: string
  durationMs: number
  // 不记录输入/输出内容（可能含 secret）
}

type PatchEvent = {
  type: "patch"
  timestamp: string
  sessionId: string
  filePath: string
  intent: string         // LLM 的修改意图
  linesChanged: number
  success: boolean
}
```

### 5.2 存储

```
位置：{project_root}/.trust-proxy/audit/
格式：NDJSON（每行一个 JSON 事件，append-only）
文件：{session_id}.ndjson

示例：
  {"type":"gate","timestamp":"2026-03-20T10:00:01Z","sessionId":"s1","toolName":"read","filePath":"src/core/crypto/aes.cpp","verdict":"PROXY_READ"}
  {"type":"projection","timestamp":"2026-03-20T10:00:02Z","sessionId":"s1","filePath":"src/core/crypto/aes.cpp","level":2,"tokenCount":512,"source":"model","guardPassed":true}
  {"type":"gate","timestamp":"2026-03-20T10:00:05Z","sessionId":"s1","toolName":"read","filePath":"include/llama.h","verdict":"PASS"}
```

### 5.3 审计查询

```bash
# 查看某次 session 的所有 gate 判定
trust-agent audit --session s1 --type gate

# 查看所有涉及某个 secret 文件的事件
trust-agent audit --file src/core/crypto/aes.cpp

# 查看所有 DENY 事件
trust-agent audit --verdict DENY

# 生成安全报告
trust-agent audit --report
# 输出：
#   Sessions: 15
#   Secret files accessed: 8
#   Total projections served: 47
#   Guard blocks: 2
#   Canary tests: 3 (all passed)
#   DENY events: 5 (all budget-related)
```
