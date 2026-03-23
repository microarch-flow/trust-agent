/**
 * MCP Server mode — trust-agent serve
 *
 * Exposes Trust Agent as a Model Context Protocol (MCP) server over stdio.
 * Compatible with Claude Desktop, opencode, and any MCP-aware client.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (newline-delimited).
 *
 * Supported methods:
 *   initialize            — MCP handshake
 *   tools/list            — enumerate available tools
 *   tools/call            — execute a tool call
 *   notifications/initialized — client ready notification (no-op)
 */

import { existsSync } from "fs"
import { join, resolve } from "path"
import * as readline from "readline"
import { loadTrustConfig, Orchestrator, type LLMModel } from "@trust-proxy/core"

const POLICY_FILE = ".trust-policy.yml"

// MCP protocol version this server implements
const MCP_PROTOCOL_VERSION = "2024-11-05"

type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: string | number | null
  method: string
  params?: Record<string, unknown>
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

function send(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n")
}

function sendError(id: string | number | null, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } })
}

// MCP tools exposed by the server
const MCP_TOOLS = [
  {
    name: "trust_agent_run",
    description:
      "Run a secure coding task using Trust Agent. " +
      "The agent reads your project files (secret files are projected, not sent raw), " +
      "executes tools, and returns the final response.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description for the coding agent",
        },
        project_root: {
          type: "string",
          description: "Absolute path to the project root (must contain .trust-policy.yml)",
        },
        max_iterations: {
          type: "number",
          description: "Maximum LLM↔tool iterations (default: 50)",
        },
      },
      required: ["task", "project_root"],
    },
  },
  {
    name: "trust_agent_status",
    description: "List recent Trust Agent sessions for a project.",
    inputSchema: {
      type: "object",
      properties: {
        project_root: {
          type: "string",
          description: "Absolute path to the project root",
        },
      },
      required: ["project_root"],
    },
  },
]

async function handleToolCall(
  id: string | number | null,
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<void> {
  if (toolName === "trust_agent_run") {
    const task = toolArgs.task as string
    const projectRoot = resolve(toolArgs.project_root as string)
    const maxIterations = (toolArgs.max_iterations as number | undefined) ?? 50

    const policyPath = join(projectRoot, POLICY_FILE)
    if (!existsSync(policyPath)) {
      sendError(id, -32602, `No .trust-policy.yml found in ${projectRoot}. Run trust-agent init first.`)
      return
    }

    const trustConfig = loadTrustConfig(policyPath, projectRoot)
    const modelConfig = trustConfig.models.driver

    // Create model from config
    let model: LLMModel
    try {
      model = await createModelFromConfig(modelConfig)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      sendError(id, -32603, `Failed to initialize model: ${msg}`)
      return
    }

    const events: string[] = []

    const orchestrator = new Orchestrator({
      projectRoot,
      trustConfig,
      model,
      onEvent: (event) => {
        // Collect events for the response
        if (event.type === "gate") {
          events.push(`[${event.verdict}] ${event.toolName ?? ""} ${event.filePath ?? ""}`.trim())
        }
      },
      approvalCallback: async (_filePath, _intent) => {
        // MCP mode: auto-approve writes (caller is responsible for policy)
        return true
      },
    })

    try {
      const result = await orchestrator.run(task, maxIterations)

      // Find the last assistant text response
      const lastText = [...result.messages]
        .reverse()
        .find((m) => m.role === "assistant" && typeof m.content === "string" && !m.content.startsWith("["))
        ?.content ?? "(no text response)"

      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: lastText,
            },
          ],
          _meta: {
            sessionId: result.session.id,
            iterations: result.iterations,
            events: events.slice(-20),  // last 20 gate events
            budgetStats: result.budgetStats,
          },
        },
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      sendError(id, -32603, `Agent execution failed: ${msg}`)
    }
    return
  }

  if (toolName === "trust_agent_status") {
    const projectRoot = resolve(toolArgs.project_root as string)
    const sessDir = join(projectRoot, ".trust-proxy", "sessions")

    if (!existsSync(sessDir)) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "No sessions found." }],
        },
      })
      return
    }

    const { readdirSync, statSync } = await import("fs")
    const files = readdirSync(sessDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const stat = statSync(join(sessDir, f))
        return { name: f.replace(".json", ""), mtime: stat.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 10)

    const lines = files.map((f) => `${f.name}  (${new Date(f.mtime).toISOString().slice(0, 19)})`)
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: lines.join("\n") || "No sessions." }],
      },
    })
    return
  }

  sendError(id, -32601, `Unknown tool: ${toolName}`)
}

export async function runServe(_args: string[]): Promise<void> {
  // Drain stdin line by line (JSON-RPC 2.0 over newline-delimited stdio)
  const rl = readline.createInterface({
    input: process.stdin,
    output: undefined,
    terminal: false,
  })

  process.stderr.write("[trust-agent MCP] listening on stdio\n")

  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let request: JsonRpcRequest
    try {
      request = JSON.parse(trimmed) as JsonRpcRequest
    } catch {
      sendError(null, -32700, "Parse error: invalid JSON")
      continue
    }

    const { id, method, params } = request

    switch (method) {
      case "initialize": {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: "trust-agent",
              version: "0.1.0",
            },
          },
        })
        break
      }

      case "notifications/initialized":
        // No response for notifications
        break

      case "tools/list": {
        send({
          jsonrpc: "2.0",
          id,
          result: { tools: MCP_TOOLS },
        })
        break
      }

      case "tools/call": {
        const toolName = (params?.name ?? params?.tool_name) as string | undefined
        const toolArgs = (params?.arguments ?? params?.input ?? {}) as Record<string, unknown>

        if (!toolName) {
          sendError(id, -32602, "Missing tool name")
          break
        }

        await handleToolCall(id, toolName, toolArgs)
        break
      }

      default:
        sendError(id, -32601, `Method not found: ${method}`)
    }
  }
}

// ── Model factory (re-uses logic from run.ts) ────────────────────

async function createModelFromConfig(config: {
  provider: string
  model: string
  apiKey?: string
  baseURL?: string
}): Promise<LLMModel> {
  const wrapVercelModel = (model: unknown): LLMModel => ({
    async doGenerate(options) {
      const { generateText } = await import("ai")
      const result = await generateText({
        model: model as Parameters<typeof generateText>[0]["model"],
        system: options.prompt,
        messages: options.messages.filter(m => m.role !== "system").map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content as string,
        })),
        tools: Object.fromEntries(
          options.tools.map((t: { name: string; description: string; parameters: unknown }) => [t.name, {
            description: t.description,
            parameters: t.parameters,
          }])
        ),
        maxSteps: 1,
      })
      return {
        text: result.text || undefined,
        finishReason: result.finishReason === "stop" ? "stop" : "tool_calls",
      }
    },
  })

  switch (config.provider) {
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      const anthropic = createAnthropic({
        apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      })
      return wrapVercelModel(anthropic(config.model))
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const openai = createOpenAI({
        apiKey: config.apiKey || process.env.OPENAI_API_KEY,
        ...(config.baseURL ? { baseURL: config.baseURL } : {}),
      })
      return wrapVercelModel(openai(config.model))
    }
    default: {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const provider = createOpenAI({
        apiKey: config.apiKey || "no-key",
        baseURL: config.baseURL ?? "http://localhost:11434/v1",
        compatibility: "compatible",
      })
      return wrapVercelModel(provider(config.model))
    }
  }
}
