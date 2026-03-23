# 04 — High-Trust Agent Pool 设计

## 1. 职责

High-Trust Agent Pool 是一组运行在本地的专精小模型，负责处理所有涉及 secret 文件原文的操作。代码不出本地，这是安全保证的物理基础。

## 2. 模型角色

### 2.1 Projector

```
用途：读源码 → 生成 Level 2 结构化投影
模型规模：< 4B（推荐 Qwen3-Coder 3B）
微调方式：全量微调或 LoRA

输入格式：
  <|system|>
  你是一个代码投影器。读取源文件，生成结构化摘要。
  输出必须严格遵循给定的 JSON schema。
  不要复制源码。不要包含内部标识符名称（除非它们出现在公开头文件中）。
  <|user|>
  Language: cpp
  Level: 2
  Source:
  {源文件全文}
  <|assistant|>

输出格式：
  固定 JSON schema（见 03-projection-system-design.md Level 2）

推理配置：
  temperature: 0.1（低随机性，确保一致输出）
  max_tokens: 2048
  stop: ["\n\n\n"]（遇到连续空行停止）
```

### 2.2 Answerer

```
用途：基于源码回答 low-trust LLM 的具体问题
模型规模：7-14B（推荐 Qwen3-Coder 7B 或 14B）
微调方式：LoRA + DPO（偏好安全回答）

输入格式：
  <|system|>
  你是一个安全域代码顾问。基于源码回答问题。
  规则：
  1. 用自然语言描述行为，不要复制源码
  2. 不要暴露内部变量名、魔法常量、具体数据结构布局
  3. 可以描述"做了什么"和"为什么"，但不要描述"怎么做的具体代码"
  4. 如果问题需要暴露过多实现细节才能回答，说"此问题需要直接访问源码"
  <|user|>
  Question: {问题}
  Context: {为什么需要这个信息}
  Files:
  --- src/core/crypto/aes.cpp ---
  {源文件全文}
  ---
  <|assistant|>

输出格式：
  自由文本回答（经过 Guard 检查后返回）

推理配置：
  temperature: 0.3
  max_tokens: 1024
```

### 2.3 Patcher

```
用途：接收 intent 描述 → 在真实源码上生成 diff
模型规模：14-30B（推荐 Qwen3-Coder 14B，复杂任务用 30B）
微调方式：LoRA，用 git commit 数据

输入格式：
  <|system|>
  你是一个代码修改器。根据修改意图在源文件上生成 unified diff。
  规则：
  1. 只修改 intent 描述的部分，不做额外改动
  2. 保持代码风格一致
  3. 如果 intent 不明确或不安全，拒绝并说明原因
  4. 输出格式为 unified diff
  <|user|>
  File: src/core/crypto/aes.cpp
  Intent: {修改意图描述}
  Context: {上下文信息}

  Current source:
  {源文件全文}
  <|assistant|>

输出格式：
  --- a/src/core/crypto/aes.cpp
  +++ b/src/core/crypto/aes.cpp
  @@ -42,6 +42,8 @@
   existing line
  -removed line
  +added line
   existing line

推理配置：
  temperature: 0.2
  max_tokens: 4096
```

### 2.4 Guard（规则引擎 + 可选分类器）

```
用途：检查 Projector/Answerer/Patcher 的输出是否泄露 secret 信息
主要实现：规则引擎（不需要大模型）
辅助：可选的 < 1B 分类器用于边界情况

规则引擎检查项：
  1. Token 匹配：从 secret 文件提取内部标识符，检查输出中是否出现
  2. 行匹配：检查输出中是否包含 secret 文件中的完整行（≥ 24 字符）
  3. 代码块检测：检查输出中是否有连续多行与源码匹配
  4. 格式校验：Projector 输出是否符合 JSON schema

速度：毫秒级
```

## 3. High-Trust Router

```typescript
type HighTrustTask =
  | { type: "project"; file: string; level: ProjectionLevel }
  | { type: "answer"; question: string; files: string[]; context?: string }
  | { type: "patch"; file: string; intent: string; context?: string }
  | { type: "guard"; content: string; sourceFiles: string[] }

type HighTrustResult =
  | { type: "projection"; result: ProjectionResult }
  | { type: "answer"; text: string; guardPassed: boolean }
  | { type: "patch"; diff: string; guardPassed: boolean; linesChanged: number }
  | { type: "guard"; passed: boolean; violations: string[] }

interface HighTrustRouter {
  route(task: HighTrustTask): Promise<HighTrustResult>
}
```

路由逻辑：

```typescript
async function route(task: HighTrustTask): Promise<HighTrustResult> {
  switch (task.type) {
    case "project":
      if (task.level <= 1) {
        // tree-sitter，不需要模型
        return projectWithTreeSitter(task)
      }
      // Level 2+: 调 Projector 模型
      const projection = await callProjector(task)
      const guardResult = await callGuard(projection.content, [task.file])
      if (!guardResult.passed) {
        // 降级到更低 level 重试
        return projectWithRetry(task, guardResult.violations)
      }
      return { type: "projection", result: projection }

    case "answer":
      const answer = await callAnswerer(task)
      const ansGuard = await callGuard(answer.text, task.files)
      return { type: "answer", text: answer.text, guardPassed: ansGuard.passed }

    case "patch":
      const diff = await callPatcher(task)
      const patchGuard = await callGuard(diff, [task.file])
      return { type: "patch", diff, guardPassed: patchGuard.passed, linesChanged: countLines(diff) }

    case "guard":
      return callGuard(task.content, task.sourceFiles)
  }
}
```

## 4. 本地模型管理

### 4.1 与 Ollama 的集成

```typescript
interface ModelManager {
  // 检查模型是否可用
  isAvailable(modelName: string): Promise<boolean>

  // 拉取模型（如果不存在）
  pull(modelName: string): Promise<void>

  // 调用模型推理
  generate(modelName: string, prompt: string, options: GenerateOptions): Promise<string>

  // 列出已安装模型
  list(): Promise<ModelInfo[]>

  // 健康检查
  health(): Promise<{ ok: boolean; models: string[]; gpu: boolean }>
}

type GenerateOptions = {
  temperature?: number
  maxTokens?: number
  stop?: string[]
  format?: "json" | "text"
}
```

### 4.2 模型配置

```yaml
# trust-proxy 模型配置（可放在 .trust-policy.yml 或独立文件）
models:
  projector:
    name: "trust-proxy-projector:3b"    # Ollama 模型名
    fallback: "qwen3-coder:3b"          # 未微调时的 fallback
    required: true                       # 必须可用

  answerer:
    name: "trust-proxy-answerer:7b"
    fallback: "qwen3-coder:7b"
    required: false                      # 不可用时 ask_high_trust 返回 DENY

  patcher:
    name: "trust-proxy-patcher:14b"
    fallback: "qwen3-coder:14b"
    required: false                      # 不可用时 PROXY_WRITE 返回 DENY

  ollama:
    host: "http://localhost:11434"       # Ollama 服务地址
    timeout: 30000                       # 推理超时 (ms)
```

### 4.3 LoRA 复用策略

如果硬件有限，可以用同一基座模型 + 不同 LoRA adapter：

```
基座：Qwen3-Coder 7B（常驻显存）

LoRA adapter 切换：
  projector.lora → 加载耗时 < 100ms
  answerer.lora  → 加载耗时 < 100ms
  patcher.lora   → 加载耗时 < 100ms（但 14B 可能需要单独的基座）

Ollama 支持：
  通过 Modelfile 定义 adapter
  FROM qwen3-coder:7b
  ADAPTER ./projector.lora
```

## 5. 微调方案

### 5.1 Projector 微调

```
基座：Qwen3-Coder 3B
方法：LoRA (r=16, alpha=32)
数据量：2000-5000 对 (source_file, projection_json)

数据制备流程：
  1. 从 GitHub 选取高质量开源项目（多语言）
  2. 随机选取源文件（100-3000 行）
  3. 用 Claude 生成高质量 Level 2 projection（teacher distillation）
  4. 人工审核 200-500 个样本，建立质量标准
  5. 过滤 Claude 输出中不符合标准的样本
  6. 按 80/10/10 划分 train/val/test

训练配置：
  epochs: 3-5
  learning_rate: 2e-4
  batch_size: 4（梯度累积到 16）
  硬件：单张 24GB GPU，约 2-4 小时

评估指标：
  - schema 合规率（输出是否符合 JSON schema）
  - 信息完整度（与 Claude teacher 的 F1 分数）
  - 安全性（Guard 通过率）
  - 推理速度（tokens/second）
```

### 5.2 Patcher 微调

```
基座：Qwen3-Coder 14B
方法：LoRA (r=16, alpha=32)
数据量：10000-50000 对 (source + intent, diff)

数据制备流程：
  1. 从 GitHub 抓取 commit history
  2. 过滤条件：
     - 单文件修改
     - diff < 200 行
     - commit message 有意义（非 "fix" "update" 等空泛信息）
  3. 用 LLM 把 commit message 改写为 intent 描述格式：
     原始："Fix off-by-one error in slot allocation"
     改写："在 slot 分配逻辑中修复边界条件：当请求的 position
            等于 slot 范围上界时，应该包含而非排除"
  4. 构造样本：(original_file + intent, diff)

训练配置：
  epochs: 2-3
  learning_rate: 1e-4
  batch_size: 2（梯度累积到 8）
  硬件：单张 24GB GPU（14B Q4 微调），约 8-12 小时

评估指标：
  - diff exact match rate（与真实 diff 的完全匹配率）
  - 编译通过率（应用 diff 后代码能编译）
  - 测试通过率（如果有测试的话）
  - intent 理解准确率（diff 是否真的做了 intent 描述的事）
```

## 6. Phase 1 的简化方案

Phase 1 不做模型微调，用现成模型 + 精心设计的 prompt 替代：

```
Projector → Claude API（同一个 cloud LLM，但走独立请求）
  注意：这意味着 Phase 1 中 secret 文件内容会发给 cloud LLM
  但这是临时方案，只用于验证端到端流程
  Phase 2 替换为本地模型

  或者：用 Qwen3-Coder 3B 的原始模型（未微调）+ 详细 prompt
  质量会差一些，但代码不出本地

Answerer → 同上

Patcher → Phase 1 不实现 PROXY_WRITE
  secret 文件的编辑在 Phase 1 中返回 DENY + 提示
  "此文件为 secret，请切换到 high-trust 模式进行编辑"

Guard → 纯规则引擎（Phase 1 就够用）
```

**Phase 1 的安全承诺因此降级为**：要么用 cloud LLM 做 projection（代码上了云但只是用于生成摘要），要么用未微调本地模型（质量差但代码不出门）。这个 trade-off 需要在文档中明确告知用户。
