# 03 — Projection 系统设计

## 1. 职责

Projection 系统负责将 secret 文件的内容转化为不同粒度的安全摘要，使 low-trust LLM 能够理解文件的功能和接口，但看不到具体实现。

## 2. 四级投影体系

### Level 0 — 存在性

```
输出示例：
  "src/core/crypto/aes.cpp 存在，2847 行，C++ 源文件"

实现：文件系统 stat，零模型调用
延迟：< 1ms
泄露风险：近零
适用场景：LLM 在探索项目结构时
```

### Level 1 — 契约（函数签名 + 类型 + 导出）

```
输出示例：
  Module: aes_encryption
  Language: C++

  Exports:
    - void aes_encrypt(const uint8_t* key, const uint8_t* input, uint8_t* output, size_t len)
    - void aes_decrypt(const uint8_t* key, const uint8_t* input, uint8_t* output, size_t len)
    - AesContext* aes_init(const AesConfig& config)
    - void aes_free(AesContext* ctx)

  Types:
    - struct AesConfig { int key_bits; int mode; }

  Includes:
    - <cstdint>
    - "crypto_common.h"

实现：tree-sitter AST 提取
延迟：< 50ms
泄露风险：极低（等价于头文件信息）
适用场景：LLM 需要了解模块接口
```

### Level 2 — 行为（语义摘要 + 不变量 + 依赖关系）

```
输出示例：
  {
    "file": "src/core/crypto/aes.cpp",
    "module": "aes_encryption",
    "level": 2,
    "exports": [
      {
        "name": "aes_encrypt",
        "signature": "void aes_encrypt(const uint8_t* key, const uint8_t* input, uint8_t* output, size_t len)",
        "behavior": "使用给定密钥对输入数据进行 AES 加密，结果写入 output 缓冲区",
        "preconditions": ["key 不为 null", "len 是 16 的倍数", "output 缓冲区至少 len 字节"],
        "postconditions": ["output 包含加密后数据", "input 不被修改"],
        "side_effects": [],
        "error_handling": "len 不是 16 倍数时 abort",
        "depends_on": ["aes_init (如果使用 context 模式)"],
        "askable": ["具体使用哪种 AES 模式", "密钥扩展的实现方式"]
      }
    ],
    "internal_state": "使用预计算的查找表加速运算",
    "complexity_hint": "单次加密为 O(len)，主要开销在轮运算",
    "test_hints": ["边界：空输入", "边界：非 16 对齐长度"]
  }

实现：Projector 小模型 (3B)
延迟：0.5-2s
泄露风险：中等（行为语义，不含实现方式）
适用场景：LLM 需要理解函数的具体行为来做规划
```

### Level 3 — 伪代码（简化逻辑，不含真实代码）

```
输出示例：
  aes_encrypt 的简化逻辑：
    1. 扩展密钥为 round_keys[]
    2. 将 input 分成 16 字节块
    3. 对每个块：
       a. 初始轮：异或 round_keys[0]
       b. 中间轮（重复 N 次）：字节替换 → 行移位 → 列混淆 → 异或 round_key
       c. 最终轮：字节替换 → 行移位 → 异或 round_key
    4. 输出加密块

实现：Answerer 中模型 (7-14B)
延迟：2-5s
泄露风险：较高（接近源码逻辑，但不含具体实现细节和优化）
适用场景：LLM 需要深入理解逻辑才能修改
```

## 3. Projection Engine 接口

```typescript
type ProjectionRequest = {
  filePath: string            // 源文件路径（在 real workspace 中）
  level: ProjectionLevel      // 请求的投影级别
  language: string            // 编程语言
  context?: string            // 可选：为什么需要这个投影（帮助模型聚焦）
}

type ProjectionResult = {
  content: string             // 投影文本
  level: ProjectionLevel      // 实际生成的级别（可能降级）
  format: "text" | "json"     // 输出格式
  tokenCount: number          // 投影的 token 数
  sourceHash: string          // 源文件 hash
  generatedAt: string         // 时间戳
  generatedBy: "treesitter" | "projector" | "answerer"
}

interface ProjectionEngine {
  project(req: ProjectionRequest): Promise<ProjectionResult>
}
```

## 4. tree-sitter 提取器（Level 0-1）

### 4.1 提取策略

```typescript
type TreeSitterExtractor = {
  // 从 AST 中提取公开信息
  extract(source: string, language: string): ExtractionResult
}

type ExtractionResult = {
  functions: FunctionSignature[]
  classes: ClassSignature[]
  types: TypeDefinition[]
  imports: string[]
  exports: string[]
  constants: ConstantDefinition[]   // 只提取名字和类型，不提取值
  lineCount: number
}

type FunctionSignature = {
  name: string
  signature: string        // 完整签名（参数 + 返回值）
  visibility: "public" | "private" | "protected" | "internal"
  isStatic: boolean
  docComment?: string      // 如果有文档注释则保留（注意：注释可能含密）
}
```

### 4.2 语言支持优先级

| 优先级 | 语言 | 复杂度 | 理由 |
|--------|------|--------|------|
| P1 | Python | 低 | 用户基数大，AST 相对简单 |
| P1 | TypeScript/JavaScript | 中 | AI 工具链主流语言 |
| P2 | C/C++ | 高 | template/namespace/overload 复杂 |
| P2 | Go | 低 | struct + interface 模型清晰 |
| P3 | Java/Kotlin | 中 | 企业场景 |
| P3 | Rust | 中 | trait/lifetime 需要特殊处理 |

### 4.3 注释中的秘密

文档注释（docstring/JSDoc）可能包含实现细节。处理策略：

```
Level 1 默认行为：
  - 保留 @param @return @throws 等结构化注释
  - 去掉自由文本注释（可能含实现细节描述）
  - 可配置：settings.include_doc_comments: true/false
```

## 5. Projection Cache

### 5.1 数据结构

```typescript
type ProjectionCacheEntry = {
  filePath: string
  level: ProjectionLevel
  content: string
  sourceHash: string          // 源文件 content hash
  tokenCount: number
  generatedAt: string
  generatedBy: string
  guardPassed: boolean
}

interface ProjectionCache {
  get(filePath: string, level: ProjectionLevel): ProjectionCacheEntry | null
  set(filePath: string, entry: ProjectionCacheEntry): void
  invalidate(filePath: string): void     // 文件变更时调用
  invalidateAll(): void
  stats(): { hits: number; misses: number; entries: number }
}
```

### 5.2 失效策略

| 触发条件 | 操作 |
|---------|------|
| Patcher 修改了 secret 文件 | `cache.invalidate(filePath)` |
| 用户手动编辑了 real workspace | 文件 watcher 检测到 hash 变化 → invalidate |
| git checkout / merge / rebase | `cache.invalidateAll()` |
| session 结束 | cache 保留（跨 session 可复用） |
| 项目 `.trust-policy.yml` 变更 | `cache.invalidateAll()` |

### 5.3 持久化

```
存储位置：
  {project_root}/.trust-proxy/cache/projections/
    {file_path_hash}_{level}.json

每个文件是一个 ProjectionCacheEntry 的 JSON 序列化
优势：跨 session 持久化，重启后无需重新生成
劣势：需要注意缓存一致性（通过 sourceHash 校验）
```

### 5.4 预热

```bash
# 项目初始化时可选的预热步骤
trust-agent warmup

# 对所有 secret 文件预生成 Level 1 + Level 2 projection
# Level 1 走 tree-sitter，毫秒级
# Level 2 走 Projector 模型，每个文件 1-2s
# 100 个 secret 文件 ≈ 2-3 分钟完成预热
```

## 6. Projection 输出格式规范

### 6.1 返回给 LLM 的格式

```
Level 0:
  [PROJECTED L0] src/core/crypto/aes.cpp
  C++ source file, 2847 lines

Level 1:
  [PROJECTED L1] src/core/crypto/aes.cpp

  ## Exports
  - void aes_encrypt(const uint8_t* key, const uint8_t* input, uint8_t* output, size_t len)
  - void aes_decrypt(...)
  - AesContext* aes_init(const AesConfig& config)
  - void aes_free(AesContext* ctx)

  ## Types
  - struct AesConfig { int key_bits; int mode; }

  ## Dependencies
  - <cstdint>, "crypto_common.h"

Level 2:
  [PROJECTED L2] src/core/crypto/aes.cpp
  (JSON 格式，见上文 Level 2 示例)

Level 3:
  [PROJECTED L3] src/core/crypto/aes.cpp
  (文本格式的伪代码描述)
```

`[PROJECTED LN]` 前缀让 LLM 明确知道这是投影而非原文。

### 6.2 Level 自动升级

LLM 可以通过 `ask_high_trust` 请求更高级别的信息，Trust Gate 根据信息预算决定是否升级：

```
LLM 当前有 Level 1 projection
  → LLM: "我需要了解 aes_encrypt 的错误处理行为"
  → ask_high_trust(question=..., files=["src/core/crypto/aes.cpp"])
  → Trust Gate 检查 info budget → 允许
  → Answerer 回答问题（本质上给了 Level 2 的部分信息）
  → info budget 递减
```
