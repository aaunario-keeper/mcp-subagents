import { z } from 'zod';
import { CONFIG } from '../config.js';
import { CompletionOptions, CompletionResult } from '../llm/provider.js';
import { LocalHybridMemoryStore } from '../memory/localMemoryStore.js';
import { RegisteredTool, ToolRegistry } from '../mcp/toolRegistry.js';
import {
  AgentDelegation,
  AgentRequest,
  AgentResult,
  AgentRole,
  ChatMessage,
  NON_DELEGATING_ROLES,
  SessionLogEntry,
  TOOL_USING_ROLES,
} from '../types.js';
import { safeParseJson } from '../utils/json.js';
import { AgenticExecutor } from './agenticExecutor.js';
import { ToolingPrompt, buildSystemPrompt, buildUserMessage } from './prompts.js';

/** Zod schema for validating agent LLM responses */
const AgentResponseSchema = z.object({
  summary: z.string(),
  rationale: z.string().optional(),
  notes: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  delegations: z
    .array(
      z.object({
        role: z.union([
          z.literal('planner'),
          z.literal('code'),
          z.literal('analysis'),
          z.literal('research'),
          z.literal('review'),
          z.literal('test'),
        ]),
        objective: z.string(),
        rationale: z.string().optional(),
      }),
    )
    .optional(),
});

/** All available agent roles */
const ROLES: AgentRole[] = ['planner', 'code', 'analysis', 'research', 'review', 'test'];


function summarizeToolAvailability(tools: RegisteredTool[]): string | null {
  if (tools.length === 0) {
    return null;
  }
  const counts = new Map<string, number>();
  for (const tool of tools) {
    counts.set(tool.server, (counts.get(tool.server) ?? 0) + 1);
  }
  const entries = Array.from(counts.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  const maxServers = 4;
  const shown = entries.slice(0, maxServers);
  const remainder = entries.length - shown.length;
  const serverSummary = shown.map(([name, count]) => `${name}(${count})`).join(', ');
  const extra = remainder > 0 ? `, +${remainder} more` : '';
  return `${tools.length} tools from ${serverSummary}${extra}.`;
}

function resolveToolingPrompt(params: {
  role: AgentRole;
  toolsAvailable: boolean;
  canUseTools: boolean;
  summary: string | null;
  discoveryError: string | null;
  workingDirectory?: string;
}): ToolingPrompt {
  if (!TOOL_USING_ROLES.includes(params.role)) {
    return { status: 'none' };
  }
  if (!params.toolsAvailable) {
    const reason = params.discoveryError ? `Discovery error: ${params.discoveryError}` : undefined;
    return { status: 'unavailable', reason };
  }
  if (!params.canUseTools) {
    return {
      status: 'blocked',
      reason: 'Missing OpenAI API key for tool use',
      summary: params.summary ?? undefined,
    };
  }
  return {
    status: 'available',
    summary: params.summary ?? undefined,
    workingDirectory: params.workingDirectory,
  };
}

/** Default maximum agents per session (prevents exponential spawning) */
const DEFAULT_MAX_AGENTS_PER_SESSION = 100;

/**
 * Configuration options for the AgentOrchestrator.
 */
export interface OrchestratorOptions {
  /** LLM caller for completions (client-provided) */
  llm: (messages: ChatMessage[], options?: CompletionOptions) => Promise<CompletionResult>;
  /** Memory store for session persistence */
  memory: LocalHybridMemoryStore;
  /** Optional tool registry for tool-using roles */
  toolRegistry?: ToolRegistry;
  /** Optional agentic executor for tool-use loop */
  agenticExecutor?: AgenticExecutor;
  /** Default values for agent execution */
  defaults: {
    model: string;
    temperature: number;
    maxDepth: number;
  };
  /** Maximum total agents allowed per session (default: 100) */
  maxAgentsPerSession?: number;
}

/**
 * Orchestrates multi-agent execution with recursive delegation support.
 *
 * The orchestrator manages:
 * - Agent execution with LLM completions
 * - Recursive delegation to child agents
 * - Session/scratchpad persistence
 * - Depth limiting to prevent infinite recursion
 */
export class AgentOrchestrator {
  private llm: (
    messages: ChatMessage[],
    options?: CompletionOptions,
  ) => Promise<CompletionResult>;
  private memory: LocalHybridMemoryStore;
  private defaults: { model: string; temperature: number; maxDepth: number };
  private toolRegistry?: ToolRegistry;
  private agenticExecutor?: AgenticExecutor;
  private maxAgentsPerSession: number;
  /** Tracks agent count per session to prevent exponential spawning */
  private sessionAgentCounts = new Map<string, number>();

  constructor(opts: OrchestratorOptions) {
    this.llm = opts.llm;
    this.memory = opts.memory;
    this.defaults = opts.defaults;
    this.toolRegistry = opts.toolRegistry;
    this.agenticExecutor = opts.agenticExecutor;
    this.maxAgentsPerSession = opts.maxAgentsPerSession ?? DEFAULT_MAX_AGENTS_PER_SESSION;
  }

  /**
   * Reset the agent count for a session (e.g., when session is cleared).
   */
  resetSessionAgentCount(sessionId: string): void {
    this.sessionAgentCounts.delete(sessionId);
  }

  /**
   * Execute an agent request with optional recursive delegation.
   *
   * @param request - Agent request with role, objective, and options
   * @returns Agent result including summary and any child results from delegations
   *
   * @example
   * ```typescript
   * const result = await orchestrator.run({
   *   role: 'planner',
   *   objective: 'Build a REST API for user management',
   *   sessionId: 'project-123',
   *   maxDepth: 3,
   * });
   * ```
   */
  async run(request: AgentRequest): Promise<AgentResult> {
    const depth = request.depth ?? 0;
    const maxDepth = request.maxDepth ?? this.defaults.maxDepth;
    const maxDelegations = request.maxDelegations ?? CONFIG.maxDelegationsPerAgent;
    const model = request.model ?? this.defaults.model;
    const sessionId = request.sessionId ?? 'default';

    // Check and increment agent count for this session (gremlin containment)
    const currentCount = this.sessionAgentCounts.get(sessionId) ?? 0;
    if (currentCount >= this.maxAgentsPerSession) {
      throw new Error(
        `Agent limit exceeded: session "${sessionId}" has spawned ${currentCount} agents ` +
          `(max: ${this.maxAgentsPerSession}). This prevents exponential agent spawning.`,
      );
    }
    this.sessionAgentCounts.set(sessionId, currentCount + 1);

    const sessionLog = await this.memory.read(sessionId);

    // Log the request to the session scratchpad
    await this.memory.append(sessionId, {
      role: request.role,
      message: request.objective,
      timestamp: new Date().toISOString(),
      meta: { depth, maxDepth, type: 'request' },
    });

    const allowDelegation = depth + 1 < maxDepth && !NON_DELEGATING_ROLES.includes(request.role);
    const forceToolUse = /\buse tools\b/i.test(request.objective);
    let toolDiscoveryError: string | null = null;
    if (
      this.toolRegistry &&
      (forceToolUse ||
        (TOOL_USING_ROLES.includes(request.role) && !this.toolRegistry.hasTools()))
    ) {
      try {
        await this.toolRegistry.refresh();
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        toolDiscoveryError = message;
        console.error(`Tool refresh failed: ${message}`);
      }
    }

    const availableTools = this.toolRegistry?.getToolsForRole(request.role) ?? [];
    const toolsAvailable = availableTools.length > 0;
    const canUseTools = this.agenticExecutor?.canExecuteWithTools(request.apiKey) ?? false;
    const toolingSummary = summarizeToolAvailability(availableTools);
    const tooling = resolveToolingPrompt({
      role: request.role,
      toolsAvailable,
      canUseTools,
      summary: toolingSummary,
      discoveryError: toolDiscoveryError,
      workingDirectory: CONFIG.projectRoot,
    });

    // Build LLM messages
    const systemPrompt = buildSystemPrompt(request.role, maxDepth, ROLES, {
      allowDelegation,
      tooling,
      maxDelegations,
    });
    const userPrompt = buildUserMessage({
      objective: request.objective,
      context: request.context,
      depth,
      maxDepth,
      allowDelegation,
      sessionLog,
    });
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const shouldUseTools =
      TOOL_USING_ROLES.includes(request.role) &&
      toolsAvailable &&
      canUseTools &&
      Boolean(this.agenticExecutor) &&
      Boolean(this.toolRegistry);
    const toolsUnavailable =
      TOOL_USING_ROLES.includes(request.role) && Boolean(this.toolRegistry) && !toolsAvailable;
    const toolAccessBlocked = TOOL_USING_ROLES.includes(request.role) && toolsAvailable && !canUseTools;
    const forceToolUseNoTools = forceToolUse && !toolsAvailable;
    const shouldNoteToolsUnavailable = toolsUnavailable && !forceToolUseNoTools;
    let raw = '';
    let parsed: z.infer<typeof AgentResponseSchema>;
    let toolAccessSkipped = toolAccessBlocked && !forceToolUse;
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;

    if (forceToolUseNoTools) {
      const note = toolDiscoveryError
        ? `Tool discovery failed: ${toolDiscoveryError}`
        : 'Retry once MCP tool discovery completes.';
      raw = JSON.stringify({
        summary: 'Tool access not ready: no tools available for this role.',
        notes: [note],
        delegations: [],
      });
    } else if (forceToolUse && toolAccessBlocked) {
      raw = JSON.stringify({
        summary: 'Tool access disabled: missing OpenAI API key.',
        notes: ['Provide openai_api_key to enable tool use.'],
        delegations: [],
      });
    } else if (shouldUseTools && this.agenticExecutor) {
      const execResult = await this.agenticExecutor.execute(systemPrompt, userPrompt, request.role, {
        apiKey: request.apiKey,
        model,
        temperature: this.defaults.temperature,
        responseFormat: 'json',
        toolChoice: forceToolUse ? 'required' : 'auto',
      });
      raw = execResult.finalContent;
      await this.logToolCalls(sessionId, execResult.toolCallHistory, depth, maxDepth);
    } else {
      const completion = await this.llm(messages, {
        model,
        temperature: this.defaults.temperature,
        responseFormat: 'json',
        apiKey: request.apiKey,
      });
      raw = completion.content ?? '';
      if (completion.usage) {
        usage = {
          promptTokens: completion.usage.promptTokens,
          completionTokens: completion.usage.completionTokens,
          totalTokens: completion.usage.promptTokens + completion.usage.completionTokens,
        };
      }
    }

    // Parse with retry on validation failure
    const parseResult = parseAgentResponse(raw);
    if (!parseResult.valid && !shouldUseTools) {
      // Retry with a reformatting prompt for non-tool agents
      const retryResponse = await this.retryWithSchemaFix(messages, raw, model, request.apiKey);
      if (retryResponse) {
        raw = retryResponse;
        parsed = parseAgentResponse(raw).data;
      } else {
        parsed = parseResult.data;
      }
    } else {
      parsed = parseResult.data;
    }
    if (toolAccessSkipped) {
      parsed = {
        ...parsed,
        notes: [...(parsed.notes ?? []), 'Tool access disabled: missing OpenAI API key.'],
      };
    }
    if (shouldNoteToolsUnavailable) {
      const note = toolDiscoveryError
        ? `MCP tools unavailable: ${toolDiscoveryError}`
        : 'MCP tools unavailable for this role; retry after tool discovery completes.';
      parsed = {
        ...parsed,
        notes: [...(parsed.notes ?? []), note],
      };
    }
    const { delegations, truncatedCount } = this.prepareDelegations(
      parsed.delegations ?? [],
      depth,
      maxDepth,
      maxDelegations,
      allowDelegation,
    );

    // Notify if delegations were truncated
    if (truncatedCount > 0) {
      parsed = {
        ...parsed,
        notes: [
          ...(parsed.notes ?? []),
          `${truncatedCount} delegation(s) skipped due to limit (max ${maxDelegations} per agent).`,
        ],
      };
    }

    // Execute delegated child agents
    const children: AgentResult[] = [];
    for (const delegate of delegations) {
      const child = await this.run({
        role: delegate.role,
        objective: delegate.objective,
        context: request.context,
        apiKey: request.apiKey,
        sessionId,
        depth: depth + 1,
        maxDepth,
        maxDelegations,
        model,
      });
      children.push(child);
    }

    const result: AgentResult = {
      role: request.role,
      summary: parsed.summary,
      rationale: parsed.rationale,
      notes: parsed.notes,
      risks: parsed.risks,
      delegations,
      children,
      raw,
      usage,
    };

    // Log the response to the session scratchpad
    await this.memory.append(sessionId, {
      role: 'assistant',
      message: result.summary,
      timestamp: new Date().toISOString(),
      meta: { depth, maxDepth, type: 'response', delegations: delegations.map((d) => d.role) },
    });

    return result;
  }

  /**
   * Filter and limit delegations based on depth and validity.
   * Returns the filtered delegations and count of any that were truncated.
   */
  private prepareDelegations(
    delegations: AgentDelegation[],
    depth: number,
    maxDepth: number,
    maxDelegations: number,
    allowDelegation: boolean,
  ): { delegations: AgentDelegation[]; truncatedCount: number } {
    // Don't allow delegations if we're at max depth
    if (!allowDelegation || depth + 1 >= maxDepth) {
      return { delegations: [], truncatedCount: delegations.length };
    }

    const valid = delegations.filter((d) => ROLES.includes(d.role));
    const truncated = valid.slice(0, maxDelegations);
    return {
      delegations: truncated,
      truncatedCount: valid.length - truncated.length,
    };
  }

  /**
   * Retry LLM call when JSON schema validation fails.
   * Asks the model to reformat its response to match the expected schema.
   */
  private async retryWithSchemaFix(
    messages: ChatMessage[],
    invalidResponse: string,
    model: string,
    apiKey?: string,
  ): Promise<string | null> {
    const fixPrompt: ChatMessage = {
      role: 'user',
      content: `Your previous response was not valid JSON or was missing required fields. Please reformat as valid JSON with these fields:
- summary (string, required): Brief summary of your work
- notes (array of strings, optional): Key observations
- delegations (array of {role, objective}, optional): Work to delegate
- rationale (string, optional): Why you took this approach
- risks (array of strings, optional): Identified risks

Previous response that needs fixing:
${invalidResponse.slice(0, 1000)}

Return ONLY valid JSON, no markdown fences or explanation.`,
    };

    try {
      const result = await this.llm([...messages, fixPrompt], {
        model,
        temperature: 0.1, // Low temperature for formatting task
        responseFormat: 'json',
        apiKey,
      });

      if (result.content && result.content.trim().length > 0) {
        const testParse = parseAgentResponse(result.content);
        if (testParse.valid) {
          return result.content;
        }
      }
    } catch (error) {
      console.error('Schema fix retry failed:', error instanceof Error ? error.message : error);
    }

    return null;
  }

  private async logToolCalls(
    sessionId: string,
    entries: Array<{ tool: string; args: Record<string, unknown>; result: string; error?: string }>,
    depth: number,
    maxDepth: number,
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    for (const entry of entries) {
      await this.memory.append(sessionId, {
        role: 'tool',
        message: `Tool call: ${entry.tool}`,
        timestamp: new Date().toISOString(),
        meta: {
          depth,
          maxDepth,
          type: 'tool_call',
          tool: entry.tool,
          args: entry.args,
          result: entry.result,
          error: entry.error,
        },
      });
    }
  }
}

interface ParseResult {
  valid: boolean;
  data: z.infer<typeof AgentResponseSchema>;
  errors?: string[];
}

/**
 * Parse and validate the raw LLM response into a structured agent response.
 * Returns validity flag and fallback data if parsing fails.
 */
function parseAgentResponse(raw: string): ParseResult {
  const parsedJson = safeParseJson<unknown>(raw);
  if (parsedJson) {
    const result = AgentResponseSchema.safeParse(parsedJson);
    if (result.success) {
      return { valid: true, data: result.data };
    }
    // Log validation errors for debugging
    const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    console.error('Agent response validation failed:', errors);
    return {
      valid: false,
      data: {
        summary: typeof (parsedJson as Record<string, unknown>).summary === 'string'
          ? (parsedJson as Record<string, unknown>).summary as string
          : raw,
        delegations: [],
        notes: ['Model response had validation errors; some fields may be missing.'],
      },
      errors,
    };
  }

  // Fallback: treat raw content as summary
  return {
    valid: false,
    data: {
      summary: raw,
      delegations: [],
      notes: ['Model response was not valid JSON; returning raw content.'],
    },
    errors: ['Invalid JSON'],
  };
}
