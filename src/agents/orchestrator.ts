import { z } from 'zod';
import { LocalHybridMemoryStore } from '../memory/localMemoryStore.js';
import { AgentDelegation, AgentRequest, AgentResult, AgentRole, SessionLogEntry } from '../types.js';
import { safeParseJson } from '../utils/json.js';
import { buildSystemPrompt, buildUserMessage } from './prompts.js';

/** Zod schema for validating agent LLM responses */
const AgentResponseSchema = z.object({
  summary: z.string(),
  rationale: z.string().optional(),
  notes: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  delegations: z
    .array(
      z.object({
        role: z.union([z.literal('planner'), z.literal('code'), z.literal('analysis')]),
        objective: z.string(),
        rationale: z.string().optional(),
      }),
    )
    .optional(),
});

/** All available agent roles */
const ROLES: AgentRole[] = ['planner', 'code', 'analysis'];

/** Maximum number of delegations allowed per agent response */
const MAX_DELEGATIONS_PER_AGENT = 4;

/**
 * Configuration options for the AgentOrchestrator.
 */
export interface OrchestratorOptions {
  /** LLM caller for completions (client-provided) */
  llm: (
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    options?: {
      model?: string;
      temperature?: number;
      responseFormat?: 'text' | 'json';
      apiKey?: string;
    },
  ) => Promise<string>;
  /** Memory store for session persistence */
  memory: LocalHybridMemoryStore;
  /** Default values for agent execution */
  defaults: {
    model: string;
    temperature: number;
    maxDepth: number;
  };
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
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    options?: {
      model?: string;
      temperature?: number;
      responseFormat?: 'text' | 'json';
      apiKey?: string;
    },
  ) => Promise<string>;
  private memory: LocalHybridMemoryStore;
  private defaults: { model: string; temperature: number; maxDepth: number };

  constructor(opts: OrchestratorOptions) {
    this.llm = opts.llm;
    this.memory = opts.memory;
    this.defaults = opts.defaults;
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
    const sessionId = request.sessionId ?? 'default';
    const sessionLog = await this.memory.read(sessionId);

    // Log the request to the session scratchpad
    await this.memory.append(sessionId, {
      role: request.role,
      message: request.objective,
      timestamp: new Date().toISOString(),
      meta: { depth, maxDepth, type: 'request' },
    });

    // Build LLM messages
    const messages = [
      { role: 'system' as const, content: buildSystemPrompt(request.role, maxDepth, ROLES) },
      {
        role: 'user' as const,
        content: buildUserMessage({
          objective: request.objective,
          context: request.context,
          depth,
          maxDepth,
          allowDelegation: depth + 1 < maxDepth,
          sessionLog,
        }),
      },
    ];

    // Get LLM completion and parse response (request JSON format for structured output)
    const raw = await this.llm(messages, {
      model: this.defaults.model,
      temperature: this.defaults.temperature,
      responseFormat: 'json',
      apiKey: request.apiKey,
    });
    const parsed = parseAgentResponse(raw);
    const delegations = this.prepareDelegations(parsed.delegations ?? [], depth, maxDepth);

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
   */
  private prepareDelegations(
    delegations: AgentDelegation[],
    depth: number,
    maxDepth: number,
  ): AgentDelegation[] {
    // Don't allow delegations if we're at max depth
    if (depth + 1 >= maxDepth) {
      return [];
    }

    return delegations
      .filter((d) => ROLES.includes(d.role))
      .slice(0, MAX_DELEGATIONS_PER_AGENT);
  }
}

/**
 * Parse and validate the raw LLM response into a structured agent response.
 * Falls back to a simple summary if parsing fails.
 */
function parseAgentResponse(raw: string): z.infer<typeof AgentResponseSchema> {
  const parsedJson = safeParseJson<unknown>(raw);
  if (parsedJson) {
    const result = AgentResponseSchema.safeParse(parsedJson);
    if (result.success) {
      return result.data;
    }
    // Log validation errors for debugging
    console.error('Agent response validation failed:', result.error.issues);
  }

  // Fallback: treat raw content as summary
  return {
    summary: raw,
    delegations: [],
    notes: ['Model response was not valid JSON; returning raw content.'],
  };
}
