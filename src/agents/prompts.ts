import { AgentRole, SessionLogEntry } from '../types.js';
import { toJson } from '../utils/json.js';

/** Brief descriptions for each agent role, used in system prompts */
const ROLE_BRIEFS: Record<AgentRole, string> = {
  planner:
    'Planner that decomposes goals, routes work to specialized agents, and returns concise plans.',
  code: 'Code-focused agent that drafts or edits code and returns minimal, actionable diffs or snippets.',
  analysis:
    'Analyst/reviewer that inspects plans or code, calls out risks, and suggests improvements.',
};

/**
 * Build the system prompt for an agent.
 *
 * @param role - The agent's role
 * @param maxDepth - Maximum delegation depth allowed
 * @param roles - All available roles for delegation
 * @returns System prompt string
 */
export function buildSystemPrompt(role: AgentRole, maxDepth: number, roles: AgentRole[]): string {
  const roster = roles.join(', ');
  return [
    `You are the ${role} agent (${ROLE_BRIEFS[role]}).`,
    `You can delegate to roles: ${roster}.`,
    `You may delegate recursively up to depth ${maxDepth}.`,
    'Return JSON only. Do not wrap in code fences.',
    'Fields: summary (string), rationale (string, optional), notes (array of strings, optional),',
    'delegations (array of {role, objective, rationale?}), risks (array of strings, optional).',
    'Prefer small, high-leverage delegations. Keep outputs terse.',
  ].join(' ');
}

/**
 * Parameters for building a user message.
 */
export interface UserMessageParams {
  /** The objective/task for the agent */
  objective: string;
  /** Optional additional context */
  context?: string;
  /** Current recursion depth */
  depth: number;
  /** Maximum allowed depth */
  maxDepth: number;
  /** Whether delegation is allowed at this depth */
  allowDelegation: boolean;
  /** Recent session log entries for context */
  sessionLog: SessionLogEntry[];
}

/**
 * Build the user message for an agent request.
 *
 * @param params - Message parameters
 * @returns JSON-formatted user message
 */
export function buildUserMessage(params: UserMessageParams): string {
  const { objective, context, depth, maxDepth, allowDelegation, sessionLog } = params;
  return toJson({
    objective,
    context,
    depth,
    maxDepth,
    allowDelegation,
    recent_session: sessionLog.slice(-6),
  });
}
