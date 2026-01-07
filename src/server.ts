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
import { AgentOrchestrator } from './agents/orchestrator.js';
import { CONFIG, requireApiKey } from './config.js';
import { LocalHybridMemoryStore } from './memory/localMemoryStore.js';
import { OpenAIProvider } from './llm/provider.js';
import { AgentRole } from './types.js';

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
  requireApiKey();

  // Initialize memory store and LLM provider
  const memory = new LocalHybridMemoryStore(path.join(CONFIG.dataDir, 'sessions'));
  const provider = new OpenAIProvider({
    apiKey: CONFIG.apiKey,
    baseUrl: CONFIG.baseUrl,
    model: CONFIG.model,
    temperature: CONFIG.temperature,
  });

  // Initialize orchestrator with defaults
  const orchestrator = new AgentOrchestrator({
    provider,
    memory,
    defaults: {
      model: CONFIG.model,
      temperature: CONFIG.temperature,
      maxDepth: CONFIG.defaultMaxDepth,
    },
  });

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
        'Planner plus recursive code/analysis subagents. Provide a session_id to preserve scratchpad between calls.',
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: planner
  // ─────────────────────────────────────────────────────────────────────────────

  const plannerSchema = z.object({
    task: z.string().describe('The task to plan and execute'),
    context: z.string().optional().describe('Additional context for the planner'),
    session_id: z.string().optional().describe('Session ID for scratchpad persistence'),
    max_depth: z.number().int().min(1).max(8).optional().describe('Maximum delegation depth (1-8)'),
  });

  server.registerTool(
    'planner',
    {
      title: 'Planner',
      description: 'Decompose a task, delegate to subagents, and return a concise plan with results.',
      inputSchema: plannerSchema,
    },
    async ({ task, context, session_id, max_depth }) => {
      const result = await orchestrator.run({
        role: 'planner',
        objective: task,
        context,
        sessionId: session_id,
        maxDepth: max_depth,
      });
      return formatResult(result);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: subagent
  // ─────────────────────────────────────────────────────────────────────────────

  const subagentSchema = z.object({
    role: z
      .union([z.literal('planner'), z.literal('code'), z.literal('analysis')])
      .describe('Agent role to execute'),
    objective: z.string().describe('Objective for the agent'),
    context: z.string().optional().describe('Additional context'),
    session_id: z.string().optional().describe('Session ID for scratchpad persistence'),
    max_depth: z.number().int().min(1).max(8).optional().describe('Maximum delegation depth (1-8)'),
  });

  server.registerTool(
    'subagent',
    {
      title: 'Subagent',
      description: 'Run a specific agent role with optional recursive delegation.',
      inputSchema: subagentSchema,
    },
    async ({ role, objective, context, session_id, max_depth }) => {
      const result = await orchestrator.run({
        role: role as AgentRole,
        objective,
        context,
        sessionId: session_id,
        maxDepth: max_depth,
      });
      return formatResult(result);
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: session_log
  // ─────────────────────────────────────────────────────────────────────────────

  const sessionSchema = z.object({
    session_id: z.string().optional().describe('Session ID (defaults to "default")'),
  });

  server.registerTool(
    'session_log',
    {
      title: 'Session log',
      description: 'Return the persisted scratchpad for a session.',
      inputSchema: sessionSchema,
    },
    async ({ session_id }) => {
      const log = await memory.read(session_id ?? 'default');
      return formatResult({ entries: log });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool: session_clear
  // ─────────────────────────────────────────────────────────────────────────────

  server.registerTool(
    'session_clear',
    {
      title: 'Session clear',
      description: 'Clear persisted scratchpad for a session.',
      inputSchema: sessionSchema,
    },
    async ({ session_id }) => {
      await memory.clear(session_id ?? 'default');
      return formatResult({ cleared: session_id ?? 'default' });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Start server
  // ─────────────────────────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('mcp-subagents server listening on stdio');
}

// Entry point
main().catch((error) => {
  console.error('Failed to start MCP server', error);
  process.exit(1);
});
