# Using Trust Agent as an MCP Server

Trust Agent exposes itself as a [Model Context Protocol](https://modelcontextprotocol.io) server via `trust-agent serve`. This lets Claude Desktop, opencode, and other MCP-aware clients call Trust Agent as a tool.

---

## Claude Desktop setup

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "trust-agent": {
      "command": "trust-agent",
      "args": ["serve"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

On Linux, the config is at `~/.config/Claude/claude_desktop_config.json`.

Restart Claude Desktop. You should see "trust-agent" in the MCP tools panel.

---

## opencode setup

Add to your `opencode.json`:

```json
{
  "mcp": {
    "trust-agent": {
      "type": "stdio",
      "command": "trust-agent",
      "args": ["serve"]
    }
  }
}
```

---

## Available MCP tools

### `trust_agent_run`

Run a secure coding task.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task` | string | ✓ | Task description for the agent |
| `project_root` | string | ✓ | Absolute path to the project (must have `.trust-policy.yml`) |
| `max_iterations` | number | — | LLM↔tool loop limit (default: 50) |

Returns the agent's final text response plus metadata (session ID, iteration count, gate events).

### `trust_agent_status`

List recent sessions for a project.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `project_root` | string | ✓ | Absolute path to the project |

---

## Testing the MCP server manually

```bash
# Start the server
trust-agent serve

# In another terminal, send a JSON-RPC initialize request
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | trust-agent serve

# List tools
echo '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' | trust-agent serve
```

---

## Security notes

- In MCP mode, **writes are auto-approved** (the calling agent has already been through its own approval flow). Set `session.atomic_writes: true` in your policy if you want batch review.
- The driver model is configured by `.trust-policy.yml` in the `project_root`. The MCP caller does not control which model runs.
- Audit logs are written to `<project_root>/.trust-proxy/audit/` as usual.
