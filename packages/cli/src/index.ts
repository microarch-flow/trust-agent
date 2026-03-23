#!/usr/bin/env bun

const args = process.argv.slice(2)
const command = args[0]

async function main() {
  switch (command) {
    case "init": {
      const { runInit } = await import("./commands/init")
      await runInit(args.slice(1))
      break
    }
    case "run": {
      const { runAgent } = await import("./commands/run")
      await runAgent(args.slice(1))
      break
    }
    case "validate": {
      const { runValidate } = await import("./commands/validate")
      await runValidate(args.slice(1))
      break
    }
    case "status": {
      const { runStatus } = await import("./commands/status")
      await runStatus(args.slice(1))
      break
    }
    case "serve": {
      const { runServe } = await import("./commands/serve")
      await runServe(args.slice(1))
      break
    }
    case "help":
    case "--help":
    case "-h":
    default:
      printUsage()
      break
  }
}

function printUsage() {
  console.log(`
trust-agent — Secure Coding Agent

Usage:
  trust-agent init [path]              Initialize trust policy for a project
  trust-agent validate [path]          Validate configuration
  trust-agent run "task"               Start a secure coding session
  trust-agent status [session-id]      View session status and audit log
  trust-agent serve                    Start MCP server (stdio)
  trust-agent help                     Show this help

run options:
  --model <model>         Driver model name
  --provider <p>          Provider (anthropic | openai | openai-compatible)
  --api-key <key>         API key (overrides environment variable)
  --base-url <url>        Base URL (for proxy or openai-compatible)
  --resume <session-id>   Resume a previous session
  --lang <en|zh>          Output language (default: en)
  --verbose               Verbose output

validate options:
  --check-connectivity         Test API connectivity
  --test-projection <file>     Preview all 4 projection levels for a file
`)
}

main().catch((err) => {
  console.error("Error:", err.message || err)
  process.exit(1)
})
