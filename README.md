# mcp-subagents

MCP stdio server that exposes a planner tool plus recursive code/analysis subagents. It is built for Codex MCP-server mode: start the process and point your MCP-capable client at stdio.

## Features
- Planner tool that decomposes tasks and delegates.
- Code and analysis subagents that can delegate recursively (depth limited).
- Session-aware scratchpad persisted to `data/sessions/*.json`.
- Uses MCP client sampling (no server-side API key needed).
- Includes a patch-package fix for GHSA-8r9q-7v3j-jr4g (UriTemplate ReDoS) in `@modelcontextprotocol/sdk@1.25.1`.

## Requirements
- Node 18.18+.
- MCP client capable of `createMessage` (Codex CLI covers this).

Optional fallback (when the client does not support sampling):
- `OPENAI_API_KEY` for direct OpenAI chat completions.
- `OPENAI_BASE_URL` to override the API base URL (defaults to `https://api.openai.com/v1`).
- You can also pass `openai_api_key` in tool arguments to provide a key per request.

## Quickstart
```powershell
cd my-repos/mcp-subagents
npm install
npm run dev   # or: npm run start after npm run build
```

Expose via Codex MCP server mode by pointing to the stdio command above.

## Usage notes
- `session_id` is normalized to `[a-zA-Z0-9_-]` (other characters become `_`). This keeps session storage filesystem-safe.
- Tool-using roles require an OpenAI API key (env var or tool argument).
- Research role can access `keeper-memory*` MCP tools (read-level by default) when configured in your MCP servers.
- `MCP_SERVERS_ALLOWLIST` supports `*` wildcards (ex: `smart-io,keeper-memory*`).
- Use `tools_status(refresh: true)` to verify tool discovery and effective access per role.

## Tools
- `planner(task, context?, session_id?, max_depth?)` – orchestrates the plan and delegates.
- `subagent(role, objective, context?, session_id?, max_depth?)` – run a specific role directly.
- `session_log(session_id?)` – read persisted scratchpad.
- `session_clear(session_id?)` – drop persisted scratchpad.
- `tool_feedback(role, tool_name?, action, level?, note?, source?)` – record tool access overrides and feedback (supports glob patterns like `smart-io:read_*`).
- `tools_status(role?, refresh?, include_all?, include_tools?)` – report MCP tool discovery status and effective tool access (optionally refresh).
- `env_status()` – report whether expected environment variables are present.

`max_depth` defaults to `AGENT_MAX_DEPTH` env (3). Session IDs let multiple conversations stay isolated.

## Environment
OpenAI fallback (used when MCP sampling is unavailable):
- `OPENAI_API_KEY` OpenAI API key for direct completions.
- `OPENAI_BASE_URL` override for the OpenAI API base URL (defaults to OpenAI's API base when unset).
- `OPENAI_MODEL` (default: `gpt-4o-mini`) preferred model for fallback completions.

MCP server discovery:
- `CODEX_CONFIG_PATH` (default: `~/.codex/config.toml`) Codex config for MCP server discovery.
- `MCP_SERVERS_CONFIG` optional JSON config path for MCP servers.
- `MCP_SERVERS_ALLOWLIST` comma-separated server names (supports `*` wildcards).

TLS / proxy:
- `NODE_EXTRA_CA_CERTS` path to a PEM bundle for custom CA certificates.

Agent tuning:
- `AGENT_MAX_DEPTH` (default: 3) maximum recursion depth for delegation (1-8).
- `AGENT_TEMPERATURE` (default: 0.2) temperature hint for completions.
- `AGENT_MAX_ITERATIONS` (default: 10) maximum tool-using iterations per agent.
- `AGENT_MAX_TOOL_CALLS` (default: 5) maximum tool calls per iteration.
- `AGENT_TOOL_ACCESS_LEVELS` per-role access levels (default: `planner=none,analysis=execute,research=read,review=read,code=execute,test=execute`; levels: `none,read,write,execute,admin`).
- `AGENT_DATA_DIR` (default: `./data`) directory for session persistence.

MCP tool timeouts/retries:
- `MCP_TOOL_TIMEOUT_MS` (default: 60000) controls per-tool call timeout.
- `MCP_LIST_TOOLS_TIMEOUT_MS` (default: 30000) controls MCP tool discovery timeout.
- `MCP_TOOL_RETRIES` (default: 1) retries throttled tool calls.
- `MCP_TOOL_RETRY_DELAY_MS` (default: 250) base delay between tool retries.
