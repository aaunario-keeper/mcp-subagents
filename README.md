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

## Quickstart
```powershell
cd my-repos/mcp-subagents
npm install
npm run dev   # or: npm run start after npm run build
```

Expose via Codex MCP server mode by pointing to the stdio command above.

## Tools
- `planner(task, context?, session_id?, max_depth?)` – orchestrates the plan and delegates.
- `subagent(role, objective, context?, session_id?, max_depth?)` – run a specific role directly.
- `session_log(session_id?)` – read persisted scratchpad.
- `session_clear(session_id?)` – drop persisted scratchpad.

`max_depth` defaults to `AGENT_MAX_DEPTH` env (3). Session IDs let multiple conversations stay isolated.
