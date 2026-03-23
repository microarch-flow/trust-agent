import { existsSync } from "fs"
import { join, resolve } from "path"
import { loadTrustConfig, ProjectionEngine, HighTrustPool, AuditLogger, Guard } from "@trust-proxy/core"

const POLICY_FILE = ".trust-policy.yml"

type CheckResult = {
  name: string
  status: "ok" | "warn" | "error"
  message: string
}

export async function runValidate(args: string[]) {
  // ── --test-projection <file> 模式 ───────────────────────────
  const testProjIdx = args.indexOf("--test-projection")
  if (testProjIdx !== -1) {
    const filePath = args[testProjIdx + 1]
    if (!filePath) {
      console.error("❌ --test-projection 需要指定文件路径")
      process.exit(1)
    }
    const projectRoot = resolve(args[0] && !args[0].startsWith("--") ? args[0] : process.cwd())
    await runTestProjection(filePath, projectRoot)
    return
  }

  const projectRoot = resolve(args[0] || process.cwd())
  const policyPath = join(projectRoot, POLICY_FILE)

  console.log(`🔍 验证 ${policyPath}\n`)

  const checks: CheckResult[] = []

  // ── 基础检查 ────────────────────────────────────────────────
  if (!existsSync(policyPath)) {
    printCheck({ name: "配置文件存在", status: "error", message: `未找到 ${POLICY_FILE}，请先运行: trust-agent init` })
    process.exit(1)
  }

  // ── 解析配置 ────────────────────────────────────────────────
  let trustConfig: Awaited<ReturnType<typeof loadTrustConfig>>
  try {
    trustConfig = loadTrustConfig(policyPath, projectRoot)
    checks.push({ name: "配置文件语法", status: "ok", message: "YAML 解析成功" })
  } catch (err) {
    printCheck({ name: "配置文件语法", status: "error", message: `解析失败: ${err}` })
    process.exit(1)
  }

  const { models, security, tools, session, audit, assetMap } = trustConfig

  // ── 文件分类检查 ─────────────────────────────────────────────
  const policy = assetMap.policy
  const secretPatterns = policy.secret.filter(p => !p.startsWith("#"))
  const ignorePatterns = policy.ignore.filter(p => !p.startsWith("#"))

  if (secretPatterns.length === 0) {
    checks.push({ name: "secret 文件规则", status: "warn", message: "未配置任何 secret 规则，所有文件将直接发送到云端 LLM" })
  } else {
    checks.push({ name: "secret 文件规则", status: "ok", message: `${secretPatterns.length} 条规则: ${secretPatterns.slice(0, 3).join(", ")}${secretPatterns.length > 3 ? "..." : ""}` })
  }

  checks.push({ name: "ignore 规则", status: "ok", message: `${ignorePatterns.length} 条规则` })

  // ── 驱动模型检查 ─────────────────────────────────────────────
  const driver = models.driver
  if (!driver.model) {
    checks.push({ name: "driver 模型", status: "error", message: "未配置 models.driver.model" })
  } else {
    checks.push({ name: "driver 模型", status: "ok", message: `${driver.provider}/${driver.model}` })
  }

  // API key 检查
  if (driver.provider === "anthropic") {
    const key = driver.apiKey || process.env.ANTHROPIC_API_KEY
    if (!key) {
      checks.push({ name: "Anthropic API Key", status: "warn", message: "未设置 apiKey 或 ANTHROPIC_API_KEY 环境变量" })
    } else {
      checks.push({ name: "Anthropic API Key", status: "ok", message: `已配置 (${key.slice(0, 8)}...)` })
    }
  } else if (driver.provider === "openai") {
    const key = driver.apiKey || process.env.OPENAI_API_KEY
    if (!key) {
      checks.push({ name: "OpenAI API Key", status: "warn", message: "未设置 apiKey 或 OPENAI_API_KEY 环境变量" })
    } else {
      checks.push({ name: "OpenAI API Key", status: "ok", message: `已配置 (${key.slice(0, 8)}...)` })
    }
  } else if (driver.provider === "openai-compatible") {
    if (!driver.baseURL) {
      checks.push({ name: "driver baseURL", status: "error", message: "openai-compatible provider 需要配置 baseURL" })
    } else {
      checks.push({ name: "driver baseURL", status: "ok", message: driver.baseURL })
    }
  }

  // ── 高信任模型检查 ───────────────────────────────────────────
  const highTrustRoles = [
    { name: "projector", config: models.projector },
    { name: "answerer", config: models.answerer },
    { name: "patcher", config: models.patcher },
  ]

  let anyHighTrust = false
  for (const role of highTrustRoles) {
    if (role.config) {
      anyHighTrust = true
      checks.push({ name: `high_trust.${role.name}`, status: "ok", message: `${role.config.baseURL} → ${role.config.model}` })
    } else {
      checks.push({ name: `high_trust.${role.name}`, status: "warn", message: "未配置（secret 文件处理能力受限）" })
    }
  }

  if (!anyHighTrust && secretPatterns.length > 0) {
    checks.push({
      name: "高信任模型",
      status: "warn",
      message: "有 secret 文件但未配置任何本地模型，将只能使用 L0/L1 投影（无行为摘要）",
    })
  }

  // ── 在线连通性检查（可选，仅当 --check-connectivity 时）────────
  if (args.includes("--check-connectivity")) {
    checks.push(await checkDriverConnectivity(driver))
    if (models.projector) checks.push(await checkHighTrustConnectivity("projector", models.projector))
    if (models.answerer) checks.push(await checkHighTrustConnectivity("answerer", models.answerer))
  }

  // ── 安全配置检查 ─────────────────────────────────────────────
  const threshold = security.guard.structure_fingerprint.similarity_threshold
  if (threshold < 0.5) {
    checks.push({ name: "结构指纹阈值", status: "warn", message: `${threshold} 偏低，可能误拦截正常投影` })
  } else if (threshold > 0.95) {
    checks.push({ name: "结构指纹阈值", status: "warn", message: `${threshold} 偏高，代码块泄漏检测可能失效` })
  } else {
    checks.push({ name: "结构指纹阈值", status: "ok", message: `${threshold}` })
  }

  if (!security.guard.meta_guard.enabled && !models.answerer) {
    checks.push({ name: "Meta-Guard", status: "warn", message: "Layer 3 已禁用且无 answerer 模型，Guard 仅有两层防护" })
  } else {
    checks.push({
      name: "Meta-Guard",
      status: security.guard.meta_guard.enabled ? "ok" : "warn",
      message: security.guard.meta_guard.enabled ? "已启用" : "已禁用",
    })
  }

  // ── 工具和会话检查 ──────────────────────────────────────────
  checks.push({ name: "bash 策略", status: "ok", message: tools.bash.policy })
  checks.push({ name: "最大迭代数", status: "ok", message: `${session.max_iterations} 轮` })
  checks.push({ name: "审计日志", status: audit.enabled ? "ok" : "warn", message: audit.enabled ? `${audit.log_dir} (保留 ${audit.retention_days} 天)` : "已禁用" })

  // ── 打印结果 ─────────────────────────────────────────────────
  for (const check of checks) {
    printCheck(check)
  }

  const errors = checks.filter(c => c.status === "error").length
  const warns = checks.filter(c => c.status === "warn").length

  console.log()
  if (errors > 0) {
    console.log(`❌ 验证失败: ${errors} 个错误，${warns} 个警告`)
    process.exit(1)
  } else if (warns > 0) {
    console.log(`⚠ 验证通过（有 ${warns} 个警告）`)
  } else {
    console.log(`✅ 验证通过，配置完整`)
  }
}

function printCheck(check: CheckResult) {
  const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "⚠" : "✗"
  const pad = check.name.padEnd(22)
  console.log(`  ${icon} ${pad} ${check.message}`)
}

async function checkDriverConnectivity(driver: { provider: string; apiKey?: string; baseURL?: string; model: string }): Promise<CheckResult> {
  try {
    if (driver.provider === "anthropic") {
      const key = driver.apiKey || process.env.ANTHROPIC_API_KEY || ""
      const res = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(5000),
      })
      return { name: "driver 连通性", status: res.ok ? "ok" : "warn", message: res.ok ? "Anthropic API 可达" : `HTTP ${res.status}` }
    } else if (driver.provider === "openai") {
      const key = driver.apiKey || process.env.OPENAI_API_KEY || ""
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5000),
      })
      return { name: "driver 连通性", status: res.ok ? "ok" : "warn", message: res.ok ? "OpenAI API 可达" : `HTTP ${res.status}` }
    } else {
      const url = `${(driver.baseURL ?? "").replace(/\/$/, "")}/models`
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
      return { name: "driver 连通性", status: res.ok ? "ok" : "warn", message: res.ok ? `${driver.baseURL} 可达` : `HTTP ${res.status}` }
    }
  } catch (err) {
    return { name: "driver 连通性", status: "warn", message: `连接失败: ${err}` }
  }
}

// ── --test-projection 实现 ─────────────────────────────────────

async function runTestProjection(filePath: string, projectRoot: string) {
  const absFile = resolve(filePath)
  const policyPath = join(projectRoot, POLICY_FILE)

  if (!existsSync(policyPath)) {
    console.error(`❌ 未找到 ${POLICY_FILE}，请先运行: trust-agent init`)
    process.exit(1)
  }
  if (!existsSync(absFile)) {
    console.error(`❌ 文件不存在: ${absFile}`)
    process.exit(1)
  }

  let trustConfig: Awaited<ReturnType<typeof loadTrustConfig>>
  try {
    trustConfig = loadTrustConfig(policyPath, projectRoot)
  } catch (err) {
    console.error(`❌ 配置解析失败: ${err}`)
    process.exit(1)
  }

  const { models, security } = trustConfig

  // 创建 ModelProjector（如果配置了 projector）
  let modelProjector: import("@trust-proxy/core").ModelProjector | undefined
  if (models.projector) {
    const pool = new HighTrustPool(
      { projector: models.projector, prompts: security.projection.prompts },
      new Guard(),
      new AuditLogger(projectRoot),
      "test",
    )
    modelProjector = {
      async project(source: string, fp: string, level) {
        const result = await pool.dispatch({ type: "project", file: fp, level })
        if (result.type === "projection") return result.result.content
        return ""
      },
    }
  }

  const engine = new ProjectionEngine(projectRoot, modelProjector)

  console.log(`\n🔬 投影测试: ${absFile}`)
  console.log(`   Projector: ${models.projector ? `${models.projector.baseURL} → ${models.projector.model}` : "未配置（L2/L3 降级到 L1）"}`)
  console.log()

  const levels = [0, 1, 2, 3] as const
  for (const level of levels) {
    const start = Date.now()
    try {
      const result = await engine.project({ filePath: absFile, level })
      const elapsed = Date.now() - start
      console.log(`${"─".repeat(60)}`)
      console.log(`L${level} 投影  [${result.generatedBy}]  ${result.tokenCount} tokens  ${elapsed}ms`)
      console.log(`${"─".repeat(60)}`)
      console.log(result.content)
      console.log()
    } catch (err) {
      console.log(`L${level} 投影  ❌ 失败: ${err}`)
    }
  }
}

async function checkHighTrustConnectivity(
  role: string,
  config: { baseURL: string; model: string; apiKey?: string },
): Promise<CheckResult> {
  try {
    const url = `${config.baseURL.replace(/\/$/, "")}/models`
    const headers: Record<string, string> = {}
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    return {
      name: `${role} 连通性`,
      status: res.ok ? "ok" : "warn",
      message: res.ok ? `${config.baseURL} 可达` : `HTTP ${res.status}`,
    }
  } catch (err) {
    return { name: `${role} 连通性`, status: "warn", message: `连接失败: ${err}` }
  }
}
