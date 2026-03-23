import { existsSync, readdirSync, statSync, writeFileSync } from "fs"
import { join, relative } from "path"

const POLICY_FILE = ".trust-policy.yml"

const SECRET_HINTS = [
  { pattern: "src/core/**", reason: "核心业务逻辑" },
  { pattern: "src/algo/**", reason: "算法实现" },
  { pattern: "src/engine/**", reason: "引擎核心" },
  { pattern: "src/crypto/**", reason: "加密模块" },
  { pattern: "lib/core/**", reason: "核心库" },
  { pattern: "internal/**", reason: "内部实现" },
]

export async function runInit(args: string[]) {
  const projectRoot = args[0] || process.cwd()
  const policyPath = join(projectRoot, POLICY_FILE)

  if (existsSync(policyPath)) {
    console.log(`⚠ ${POLICY_FILE} 已存在于 ${projectRoot}`)
    console.log("  如需重新初始化，请先删除该文件。")
    return
  }

  console.log(`🔍 扫描项目目录: ${projectRoot}`)
  const detected = scanForSecrets(projectRoot)

  const rulesYaml = detected.length > 0
    ? detected.map(d => `    - pattern: "${d.pattern}"\n      level: secret\n      reason: ${d.reason}`).join("\n")
    : `    # - pattern: "src/core/**"\n    #   level: secret\n    #   reason: 核心算法逻辑`

  const content = `# .trust-policy.yml
# Trust Proxy 安全策略配置
#
# 双模型架构：
#   云端 LLM（低信任）驱动编码任务，看不到 secret 文件原文
#   本地模型（高信任）处理 secret 文件，结果经 Guard 过滤后返回
#
# 文档：https://github.com/your-org/trust-proxy

version: "1"

# ── 文件分类 ────────────────────────────────────────────────────────────────
# secret: 核心代码，永不发送到云端 LLM
# derived: 从 secret 派生，部分脱敏后可发送
# public: 可直接发送（默认）
# rules 优先级：ignore > secret/derived（按声明顺序）
assets:
  default: public
  rules:
${rulesYaml}
  ignore:
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/*_test.*"
    - "**/types.ts"
    - "**/types.h"
    - "**/interface.h"
    - "**/*.d.ts"

# ── 提供商定义 ────────────────────────────────────────────────────────────────
# 在此定义 API 提供商，然后在 models 中按名称引用
# 支持 \${ENV_VAR} 环境变量插值
providers:
  anthropic:
    api: anthropic
    apiKey: \${ANTHROPIC_API_KEY}

  openai:
    api: openai
    apiKey: \${OPENAI_API_KEY}

  # openai-compatible 格式：api 固定写 openai-compatible，URL 放 baseURL
  # 适用于：本地 Ollama / vLLM / llama.cpp，以及云端兼容接口（DeepSeek、月之暗面、iflow 等）
  local:
    api: openai-compatible
    baseURL: http://localhost:11434/v1    # 本地 Ollama 示例
    # 可选：预定义模型元数据（不影响运行）
    models:
      qwen2.5-coder:1.5b:
        contextWindow: 32768
        maxTokens: 4096
      qwen2.5-coder:7b:
        contextWindow: 32768
        maxTokens: 8192

  # 云端 openai-compatible 示例（取消注释并填写）
  # mycloud:
  #   api: openai-compatible
  #   baseURL: https://your-api-endpoint/v1
  #   apiKey: \${MY_CLOUD_API_KEY}

# ── 模型角色分配 ───────────────────────────────────────────────────────────────
models:
  # 云端驱动模型（低信任）— 执行编码任务，看不到 secret 原文
  driver:
    provider: anthropic
    model: claude-sonnet-4-20250514

  # 本地高信任模型 — 按角色分配
  projector:                          # 生成 L2/L3 投影摘要（轻量模型）
    provider: local
    model: qwen2.5-coder:1.5b

  answerer:                           # 回答 ask_high_trust 问题（较强模型）
    provider: local
    model: qwen2.5-coder:7b

  patcher:                            # 修改 secret 文件
    provider: local
    model: qwen2.5-coder:7b

  # meta_guard 不填则自动继承 answerer
  # meta_guard:
  #   provider: local
  #   model: qwen2.5-coder:1.5b

# ── 安全配置 ──────────────────────────────────────────────────────────────────
security:
  projection:
    default_level: 2                  # 默认投影级别 (0=stat, 1=签名, 2=行为摘要, 3=伪代码)
    max_level: 3
    budget:
      tokens_per_file: 4096           # 每 secret 文件 token 上限
      ask_limit: 20                   # 每 session ask_high_trust 次数上限

  guard:
    # Layer 1: token 精确匹配
    token_match:
      enabled: true
      min_token_length: 7
      known_safe_tokens: []           # 白名单 token（不视为泄漏）

    # Layer 2: 控制流结构指纹（trigram n-gram 相似度）
    structure_fingerprint:
      enabled: true
      similarity_threshold: 0.75     # 0~1，越低越严格

    # Layer 3: 本地模型语义审查（SAFE/UNSAFE 判定）
    meta_guard:
      enabled: true
      max_tokens: 20

    canary:
      auto_plant: false               # 是否每次 session 自动植入 canary token

# ── 工具配置 ──────────────────────────────────────────────────────────────────
tools:
  allowed:
    - read
    - edit
    - write
    - grep
    - glob
    - bash
    - ask_high_trust

  bash:
    # workspace_isolated: 普通命令走 public workspace（推荐）
    # unrestricted: 所有命令走真实项目目录
    # disabled: 禁用 bash 工具
    policy: workspace_isolated
    build_commands_pass_through: true  # cmake/make/cargo/git 等走真实目录

  grep:
    exclude_dirs:
      - node_modules
      - .git
      - dist
      - .trust-proxy

# ── 会话配置 ──────────────────────────────────────────────────────────────────
session:
  max_iterations: 50                  # LLM 最大对话轮数

  workspace:
    enabled: false                    # 是否启用双 workspace 物理隔离
    mode: symlink                     # symlink | copy

# ── 审计日志 ──────────────────────────────────────────────────────────────────
audit:
  enabled: true
  log_dir: .trust-proxy/audit
  retention_days: 30
`

  writeFileSync(policyPath, content)
  console.log(`\n✅ 已创建 ${POLICY_FILE}`)

  if (detected.length > 0) {
    console.log(`\n📋 检测到以下可能的 secret 模式:`)
    for (const d of detected) {
      console.log(`   - ${d.pattern}  (${d.reason})`)
    }
  }

  console.log(`\n📝 请编辑 ${policyPath}:`)
  console.log(`   1. 确认 assets.rules 中的 secret 文件范围`)
  console.log(`   2. 在 providers 中填写 API key（或设置环境变量）`)
  console.log(`   3. 确认 models.driver 的模型名称`)
  console.log(`\n   然后运行: trust-agent run "你的任务描述"`)
}

function scanForSecrets(projectRoot: string): { pattern: string; reason: string }[] {
  const found: { pattern: string; reason: string }[] = []

  for (const hint of SECRET_HINTS) {
    const dirPart = hint.pattern.split("/")[0]
    const checkPaths = [
      join(projectRoot, dirPart),
      join(projectRoot, "src", dirPart),
    ]

    for (const checkPath of checkPaths) {
      if (existsSync(checkPath) && statSync(checkPath).isDirectory()) {
        const rel = relative(projectRoot, checkPath).replace(/\\/g, "/")
        found.push({ pattern: `${rel}/**`, reason: hint.reason })
        break
      }
    }
  }

  // 去重
  const seen = new Set<string>()
  return found.filter(f => {
    if (seen.has(f.pattern)) return false
    seen.add(f.pattern)
    return true
  })
}
