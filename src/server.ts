/**
 * MCP Server for multi-agent orchestration.
 *
 * Exposes tools for:
 * - planner: Decompose tasks and delegate to subagents
 * - subagent: Run a specific agent role directly
 * - session_log: Read the session scratchpad
 * - session_clear: Clear the session scratchpad
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'path';
import { AgenticExecutor } from './agents/agenticExecutor.js';
import { AgentOrchestrator } from './agents/orchestrator.js';
import { CONFIG } from './config.js';
import { DirectOpenAiProvider, createDefaultProvider } from './llm/provider.js';
import { LocalHybridMemoryStore, normalizeSessionId } from './memory/localMemoryStore.js';
import { parseCodexConfig, extractMcpServers, parseCustomServersConfig } from './mcp/configParser.js';
import { McpClientManager } from './mcp/clientManager.js';
import type { McpServerConfig } from './mcp/clientManager.js';
import { ToolFeedbackStore } from './mcp/toolFeedbackStore.js';
import { ToolRegistry } from './mcp/toolRegistry.js';
import { AgentRole, TOOL_ACCESS_LEVELS } from './types.js';

function matchesAllowlist(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (pattern === name) {
      return true;
    }
    if (pattern.includes('*')) {
      const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
      if (regex.test(name)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Format a result payload for MCP tool response.
 */
function formatResult(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Main entry point for the MCP server.
 */
async function main(): Promise<void> {
  // Initialize memory store with size cap to prevent unbounded log growth
  const memory = new LocalHybridMemoryStore(
    path.join(CONFIG.dataDir, 'sessions'),
    CONFIG.maxSessionLogBytes,
  );

  // Create MCP server
  const server = new McpServer(
    {
      name: 'mcp-subagents',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions:
        'Planner plus recursive code/analysis/research/review/test subagents. Provide a session_id to preserve scratchpad between calls. Tool-using roles require an OpenAI API key.',
    },
  );

  // Initialize LLM provider using MCP sampling
  const provider = createDefaultProvider(server, {
    model: CONFIG.model,
    temperature: CONFIG.temperature,
  });

  const directProvider = new DirectOpenAiProvider({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    defaultModel: CONFIG.model,
    defaultTemperature: CONFIG.temperature,
  });

  // Initialize MCP client manager for external tools (lazy connect)
  const clientManager = new McpClientManager({
    toolCallTimeoutMs: CONFIG.mcpToolTimeoutMs,
    listToolsTimeoutMs: CONFIG.mcpListToolsTimeoutMs,
    toolCallRetries: CONFIG.mcpToolRetries,
    toolCallRetryDelayMs: CONFIG.mcpToolRetryDelayMs,
  });
  const toolRegistry = new ToolRegistry(clientManager, {
    roleAccessLevels: CONFIG.toolAccessLevels,
  });
  const feedbackStore = new ToolFeedbackStore(path.join(CONFIG.dataDir, 'tool-feedback.json'));
  const feedbackState = await feedbackStore.read();
  let currentToolOverrides = feedbackState.overrides;
  toolRegistry.setAccessOverrides(currentToolOverrides);

  const initTooling = async () => {
    let mcpConfigs: McpServerConfig[] = [];
    try {
      if (CONFIG.mcpServersConfigPath) {
        mcpConfigs = await parseCustomServersConfig(CONFIG.mcpServersConfigPath);
        console.error(
          `Loaded ${mcpConfigs.length} MCP server configs from ${CONFIG.mcpServersConfigPath}`,
        );
      } else {
        const codexConfig = await parseCodexConfig(CONFIG.codexConfigPath);
        mcpConfigs = extractMcpServers(codexConfig);
        console.error(`Loaded ${mcpConfigs.length} MCP server configs from ${CONFIG.codexConfigPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to load MCP server config: ${message}. Tool-using agents will be disabled.`);
      return;
    }

    if (CONFIG.mcpServersAllowlist.length > 0) {
      const before = mcpConfigs.length;
      mcpConfigs = mcpConfigs.filter((config) =>
        matchesAllowlist(config.name, CONFIG.mcpServersAllowlist),
      );
      console.error(`Filtered MCP servers by allowlist (${mcpConfigs.length}/${before} enabled).`);
    }

    if (mcpConfigs.length === 0) {
      return;
    }

    console.error('Starting MCP tool discovery in background...');
    await clientManager.connectAll(mcpConfigs);
    await toolRegistry.refresh();
    toolRegistry.setAccessOverrides(currentToolOverrides);
    console.error('MCP tool discovery complete.');
  };

  const agenticExecutor = new AgenticExecutor({
    llm: (messages, options) => directProvider.complete(messages, options),
    toolRegistry,
    maxIterations: CONFIG.maxAgentIterations,
    maxToolCallsPerIteration: CONFIG.maxToolCallsPerIteration,
    hasDefaultApiKey: directProvider.hasApiKey(),
  });

  // Initialize orchestrator with defaults and agent limits (gremlin containment)
  const orchestrator = new AgentOrchestrator({
    llm: (messages, options) => provider.complete(messages, options),
    memory,
    toolRegistry,
    agenticExecutor,
    defaults: {
      model: CONFIG.model,
      temperature: CONFIG.temperature,
      maxDepth: CONFIG.defaultMaxDepth,
    },
    maxAgentsPerSession: CONFIG.maxAgentsPerSession,
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: planner
  // ─────────────────────────────────────────────────────────────────────────────

  const plannerSchema = z.object({
    task: z.string().describe('The task to plan and execute'),
    context: z.string().optional().describe('Additional context for the planner'),
    session_id: z.string().optional().describe('Session ID for scratchpad persistence'),
    max_depth: z.number().int().min(1).max(8).optional().describe('Maximum delegation depth (1-8)'),
    max_delegations: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Maximum delegations per agent response (default 2, max 10). Increase for broader analysis.'),
    model: z
      .string()
      .optional()
      .describe('Model to use (default gpt-4o-mini). Use gpt-4o or gpt-4-turbo for better reasoning.'),
    openai_api_key: z
      .string()
      .min(1)
      .optional()
      .describe('Optional OpenAI API key for tool use or when sampling is unavailable'),
  });

  server.registerTool(
    'planner',
    {
      title: 'Planner',
      description: 'Decompose a task, delegate to subagents, and return a concise plan with results.',
      inputSchema: plannerSchema,
    },
    async ({ task, context, session_id, max_depth, max_delegations, model, openai_api_key }) => {
      const sessionId = normalizeSessionId(session_id ?? 'default');
      const result = await orchestrator.run({
        role: 'planner',
        objective: task,
        context,
        apiKey: openai_api_key,
        sessionId,
        maxDepth: max_depth,
        maxDelegations: max_delegations,
        model,
      });
      return formatResult(result);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: subagent
  // ─────────────────────────────────────────────────────────────────────────────

  const subagentSchema = z.object({
    role: z
      .union([
        z.literal('planner'),
        z.literal('code'),
        z.literal('analysis'),
        z.literal('research'),
        z.literal('review'),
        z.literal('test'),
      ])
      .describe('Agent role to execute'),
    objective: z.string().describe('Objective for the agent'),
    context: z.string().optional().describe('Additional context'),
    session_id: z.string().optional().describe('Session ID for scratchpad persistence'),
    max_depth: z.number().int().min(1).max(8).optional().describe('Maximum delegation depth (1-8)'),
    max_delegations: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Maximum delegations per agent response (default 2, max 10). Increase for broader analysis.'),
    model: z
      .string()
      .optional()
      .describe('Model to use (default gpt-4o-mini). Use gpt-4o or gpt-4-turbo for better reasoning.'),
    openai_api_key: z
      .string()
      .min(1)
      .optional()
      .describe('Optional OpenAI API key for tool use or when sampling is unavailable'),
  });

  server.registerTool(
    'subagent',
    {
      title: 'Subagent',
      description: 'Run a specific agent role with optional recursive delegation.',
      inputSchema: subagentSchema,
    },
    async ({ role, objective, context, session_id, max_depth, max_delegations, model, openai_api_key }) => {
      const sessionId = normalizeSessionId(session_id ?? 'default');
      const result = await orchestrator.run({
        role: role as AgentRole,
        objective,
        context,
        apiKey: openai_api_key,
        sessionId,
        maxDepth: max_depth,
        maxDelegations: max_delegations,
        model,
      });
      return formatResult(result);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: session_log
  // ─────────────────────────────────────────────────────────────────────────────

  const sessionLogSchema = z.object({
    session_id: z.string().optional().describe('Session ID (defaults to "default")'),
    offset: z.number().int().min(0).optional().describe('Number of entries to skip from the start'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of entries to return (default 50, max 100)'),
    summary_only: z
      .boolean()
      .optional()
      .describe('If true, return only entry count and byte size without full content'),
  });

  server.registerTool(
    'session_log',
    {
      title: 'Session log',
      description: 'Return the persisted scratchpad for a session.',
      inputSchema: sessionLogSchema,
    },
    async ({ session_id, offset, limit, summary_only }) => {
      const sessionId = normalizeSessionId(session_id ?? 'default');
      const log = await memory.read(sessionId);

      // Summary mode - just return stats without full content
      if (summary_only) {
        const totalBytes = Buffer.byteLength(JSON.stringify(log), 'utf8');
        return formatResult({
          session_id: sessionId,
          entry_count: log.length,
          total_bytes: totalBytes,
          oldest_entry: log[0]?.timestamp ?? null,
          newest_entry: log[log.length - 1]?.timestamp ?? null,
        });
      }

      // Apply pagination
      const startIdx = offset ?? 0;
      const maxEntries = limit ?? 50;
      const paginatedLog = log.slice(startIdx, startIdx + maxEntries);

      return formatResult({
        session_id: sessionId,
        total_entries: log.length,
        offset: startIdx,
        limit: maxEntries,
        returned: paginatedLog.length,
        has_more: startIdx + paginatedLog.length < log.length,
        entries: paginatedLog,
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: session_clear
  // ─────────────────────────────────────────────────────────────────────────────

  const sessionClearSchema = z.object({
    session_id: z.string().optional().describe('Session ID (defaults to "default")'),
  });

  server.registerTool(
    'session_clear',
    {
      title: 'Session clear',
      description: 'Clear persisted scratchpad for a session and reset agent count.',
      inputSchema: sessionClearSchema,
    },
    async ({ session_id }) => {
      const sessionId = normalizeSessionId(session_id ?? 'default');
      await memory.clear(sessionId);
      orchestrator.resetSessionAgentCount(sessionId);
      return formatResult({ cleared: sessionId });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: tool_feedback
  // ─────────────────────────────────────────────────────────────────────────────

  const toolFeedbackSchema = z.object({
    role: z
      .union([
        z.literal('planner'),
        z.literal('code'),
        z.literal('analysis'),
        z.literal('research'),
        z.literal('review'),
        z.literal('test'),
      ])
      .describe('Agent role to update'),
    tool_name: z
      .string()
      .optional()
      .describe('Tool name (canonical server:tool, OpenAI-safe name, or glob pattern)'),
    action: z
      .enum(['allow', 'deny', 'set_level', 'clear', 'note', 'check'])
      .describe('Feedback action'),
    level: z
      .enum(TOOL_ACCESS_LEVELS)
      .optional()
      .describe('Required when action is set_level'),
    note: z.string().optional().describe('Optional feedback note'),
    source: z.string().optional().describe('Optional feedback source'),
  }).superRefine((data, ctx) => {
    if (data.action !== 'check' && (!data.tool_name || data.tool_name.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tool_name'],
        message: 'tool_name is required unless action is check.',
      });
    }
    if (data.action === 'set_level' && !data.level) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['level'],
        message: 'level is required when action is set_level.',
      });
    }
  });

  server.registerTool(
    'tool_feedback',
    {
      title: 'Tool feedback',
      description:
        'Record tool feedback and update per-role tool access overrides (allow/deny/set_level). Accepts glob patterns in tool_name.',
      inputSchema: toolFeedbackSchema,
    },
    async ({ role, tool_name, action, level, note, source }) => {
      if (action === 'check') {
        const current = await feedbackStore.read();
        return formatResult({
          ok: true,
          overrides: current.overrides,
          history: current.history.filter((entry) => entry.role === role).slice(-10),
        });
      }
      const resolvedName = tool_name
        ? toolRegistry.resolveToolName(tool_name) ?? tool_name
        : '';
      const updated = await feedbackStore.applyFeedback({
        role: role as AgentRole,
        toolName: resolvedName,
        action,
        level,
        note,
        source,
      });
      currentToolOverrides = updated.overrides;
      toolRegistry.setAccessOverrides(currentToolOverrides);
      return formatResult({ ok: true, overrides: currentToolOverrides });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: tools_status
  // ─────────────────────────────────────────────────────────────────────────────

  const toolsStatusSchema = z.object({
    role: z
      .union([
        z.literal('planner'),
        z.literal('code'),
        z.literal('analysis'),
        z.literal('research'),
        z.literal('review'),
        z.literal('test'),
      ])
      .optional()
      .describe('Optional role to filter tools by effective access'),
    refresh: z.boolean().optional().describe('Refresh tool discovery before reporting status'),
    include_all: z
      .boolean()
      .optional()
      .describe('Include tools not allowed for the role (adds allowed=false)'),
    include_tools: z
      .boolean()
      .optional()
      .describe('Include full tool list when role is not specified'),
  });

  server.registerTool(
    'tools_status',
    {
      title: 'Tools status',
      description:
        'Report MCP tool discovery status and effective tool access by role. Use refresh to force discovery.',
      inputSchema: toolsStatusSchema,
    },
    async ({ role, refresh, include_all, include_tools }) => {
      let refreshError: string | null = null;
      if (refresh) {
        try {
          await toolRegistry.refresh();
          toolRegistry.setAccessOverrides(currentToolOverrides);
        } catch (error) {
          refreshError = error instanceof Error ? error.message : String(error);
        }
      }

      const servers = clientManager.getServerSummary();
      const allTools = toolRegistry.getToolsCatalog();
      const roleTools = role
        ? toolRegistry.getToolsCatalogForRole(role as AgentRole, Boolean(include_all))
        : undefined;
      const tools = role ? roleTools : include_tools ? allTools : undefined;

      return formatResult({
        ok: !refreshError,
        refreshed: Boolean(refresh),
        refreshError,
        servers,
        totalTools: allTools.length,
        role: role ?? null,
        roleAccessLevel: role ? toolRegistry.getEffectiveAccessLevel(role as AgentRole) : null,
        tools,
        overrides: currentToolOverrides,
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: env_status
  // ─────────────────────────────────────────────────────────────────────────────

  const envStatusSchema = z.object({});

  server.registerTool(
    'env_status',
    {
      title: 'Env status',
      description:
        'Report whether expected environment variables are present (no secrets).',
      inputSchema: envStatusSchema,
    },
    async () => {
      return formatResult({
        envPath: path.join(CONFIG.projectRoot, '.env'),
        hasOpenAiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
        hasExtraCa: Boolean(process.env.NODE_EXTRA_CA_CERTS?.trim()),
        extraCaPath: process.env.NODE_EXTRA_CA_CERTS ?? null,
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Start server
  // ─────────────────────────────────────────────────────────────────────────────

  const shutdown = async () => {
    await clientManager.disconnectAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-subagents server listening on stdio');
  void initTooling().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Background MCP tool discovery failed: ${message}`);
  });
}

// Entry point
main().catch((error) => {
  console.error('Failed to start MCP server', error);
  process.exit(1);
});
