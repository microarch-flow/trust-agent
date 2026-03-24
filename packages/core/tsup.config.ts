import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  dts: {
    // 覆盖 tsconfig 中的 bun-types，避免 dts pass 引入 bun 全局类型
    compilerOptions: {
      types: [],
    },
  },
  clean: true,
  sourcemap: true,
})
