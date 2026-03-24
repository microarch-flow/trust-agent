import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  dts: {
    // 使用 node types 替代 bun-types，避免 dts pass 引入 bun 全局类型
    compilerOptions: {
      types: ["node"],
      composite: false,
    },
  },
  clean: true,
  sourcemap: true,
})
