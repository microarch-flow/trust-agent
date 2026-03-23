#!/usr/bin/env bun
/**
 * test-projection.ts — 投影质量开发工具
 *
 * 用法:
 *   bun run packages/core/script/test-projection.ts <file> [policy-dir]
 *
 * 输出文件的 L0/L1/L2/L3 四级投影，显示:
 *   - 生成方式 (stat / treesitter / model)
 *   - 耗时 (ms)
 *   - token 数
 *   - 投影内容
 *
 * 需要 .trust-policy.yml 在 policy-dir（默认 process.cwd()）
 */

import { resolve, join } from "path"
import { existsSync } from "fs"
import { loadTrustConfig, ProjectionEngine, HighTrustPool, Guard, AuditLogger } from "../src/index"
import type { ModelProjector } from "../src/projection/engine"
import type { ProjectionLevel } from "../src/types"

const [, , fileArg, policyDirArg] = process.argv

if (!fileArg) {
  console.error("用法: bun run script/test-projection.ts <file> [policy-dir]")
  process.exit(1)
}

const absFile = resolve(fileArg)
const projectRoot = resolve(policyDirArg ?? process.cwd())
const policyPath = join(projectRoot, ".trust-policy.yml")

if (!existsSync(absFile)) {
  console.error(`❌ 文件不存在: ${absFile}`)
  process.exit(1)
}

if (!existsSync(policyPath)) {
  console.error(`❌ 未找到 .trust-policy.yml 在 ${projectRoot}`)
  process.exit(1)
}

const trustConfig = loadTrustConfig(policyPath, projectRoot)
const { models, security } = trustConfig

// 创建 ModelProjector
let modelProjector: ModelProjector | undefined
if (models.projector) {
  const pool = new HighTrustPool(
    { projector: models.projector, prompts: security.projection.prompts },
    new Guard(),
    new AuditLogger(projectRoot),
    "test-proj",
  )
  modelProjector = {
    async project(_source: string, fp: string, level: ProjectionLevel) {
      const result = await pool.dispatch({ type: "project", file: fp, level })
      if (result.type === "projection") return result.result.content
      return ""
    },
  }
}

const engine = new ProjectionEngine(projectRoot, modelProjector)

console.log(`\n${"═".repeat(70)}`)
console.log(`投影测试: ${absFile}`)
console.log(`Projector: ${models.projector ? `${models.projector.baseURL} → ${models.projector.model}` : "未配置 (L2/L3 → L1 降级)"}`)
console.log(`Default level: ${security.projection.default_level}`)
console.log(`${"═".repeat(70)}\n`)

const levels: ProjectionLevel[] = [0, 1, 2, 3]

for (const level of levels) {
  const start = Date.now()
  try {
    const result = await engine.project({ filePath: absFile, level })
    const elapsed = Date.now() - start

    const bar = "─".repeat(70)
    console.log(bar)
    console.log(`L${level} | ${result.generatedBy.padEnd(12)} | ${String(result.tokenCount).padStart(5)} tokens | ${elapsed}ms`)
    console.log(bar)
    console.log(result.content)
    console.log()
  } catch (err) {
    console.log(`L${level} | ❌ 失败: ${err}`)
  }
}

console.log(`${"═".repeat(70)}`)
