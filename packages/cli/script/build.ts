#!/usr/bin/env bun

import path from "path"
import pkg from "../package.json"

const dir = path.resolve(import.meta.dir, "..")

const singleFlag = process.argv.includes("--single")

type Target = {
  os: string
  arch: "arm64" | "x64"
}

const allTargets: Target[] = [
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
]

const targets = singleFlag
  ? allTargets.filter((t) => t.os === process.platform && t.arch === process.arch)
  : allTargets

for (const target of targets) {
  const name = `trust-agent-${target.os}-${target.arch}`
  console.log(`Building ${name}...`)

  await Bun.build({
    entrypoints: [path.join(dir, "src/index.ts")],
    outdir: path.join(dir, "dist"),
    target: "bun",
    compile: {
      target: `bun-${target.os}-${target.arch}` as any,
      outfile: path.join(dir, "dist", name, "trust-agent"),
    },
    define: {
      TRUST_AGENT_VERSION: JSON.stringify(pkg.version),
    },
  })

  console.log(`  -> dist/${name}/trust-agent`)
}

console.log("\nBuild complete!")
