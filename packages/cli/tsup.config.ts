import { defineConfig } from "tsup"
import { cpSync } from "fs"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  clean: true,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // 将 core 打入 CLI bundle，pnpm 用户无需单独构建 core
  noExternal: ["@trust-proxy/core"],
  onSuccess() {
    // orchestrator 在运行时通过 import.meta.url 动态加载 prompts/*.md
    // 构建后这些文件必须存在于 dist/prompts/ 下
    // 使用直接的 monorepo 相对路径，避免依赖 pnpm/bun node_modules 结构
    cpSync(
      new URL("../../core/src/orchestrator/prompts", import.meta.url),
      new URL("./dist/prompts", import.meta.url),
      { recursive: true }
    )
    console.log("✓ Copied prompts assets to dist/prompts/")
  },
})
