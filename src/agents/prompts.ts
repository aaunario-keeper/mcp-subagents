import { AgentRole, SessionLogEntry } from '../types.js';
import { toJson } from '../utils/json.js';

/** Brief descriptions for each agent role, used in system prompts */
const ROLE_BRIEFS: Record<AgentRole, string> = {
  planner:
    'Planner that decomposes goals, routes work to specialized agents, and returns concise plans.',
  code: 'Code-focused agent that reads, writes, and executes code. Uses tools to interact with the filesystem and run commands.',
  analysis: 'Analyst/reviewer that inspects plans or code, calls out risks, and suggests improvements.',
  research:
    'Research agent that gathers information from web searches, documentation, and files. Synthesizes findings into actionable summaries.',
  review:
    'Code reviewer that examines code for bugs, style issues, security concerns, and improvement opportunities. Uses static analysis tools.',
  test: 'Testing agent that generates test cases, runs test suites, and reports on coverage and failures.',
};

const ROLE_GUIDELINES: Record<AgentRole, string> = {
  planner: 'Prefer clear, staged plans and delegate only when it meaningfully helps.',
  code: 'Make minimal, correct changes. Use find_files to locate files before reading. Reference specific file:line in notes.',
  analysis: 'Surface risks with specific file:line references and concrete evidence. Use find_files first if paths unknown.',
  research: 'Cite sources with URLs or file:line references. Note uncertainty when information is incomplete.',
  review: 'Report issues as file:line with severity. Use find_files to discover structure before reading files.',
  test: 'Reference test files by path. Report pass/fail with specific file:line for failures.',
};

export interface ToolingPrompt {
  status: 'none' | 'available' | 'unavailable' | 'blocked';
  summary?: string;
  reason?: string;
  /** Working directory for file operations */
  workingDirectory?: string;
}

export interface SystemPromptOptions {
  allowDelegation: boolean;
  tooling: ToolingPrompt;
}

function buildToolingLine(tooling: ToolingPrompt): string {
  if (tooling.status === 'available') {
    const summary = tooling.summary ? ` ${tooling.summary}` : '';
    const cwdNote = tooling.workingDirectory
      ? ` Working directory: ${tooling.workingDirectory}. Always use absolute paths or paths relative to this directory.`
      : '';
    return `Tool access is enabled.${summary}${cwdNote} Use tools to verify facts and avoid guessing.`;
  }
  if (tooling.status === 'blocked') {
    const reason = tooling.reason ? `: ${tooling.reason}` : '';
    return `Tool access is disabled${reason}. Do not claim to have used tools.`;
  }
  if (tooling.status === 'unavailable') {
    const reason = tooling.reason ? `: ${tooling.reason}` : '';
    return `Tool access is unavailable${reason}. Do not claim to have used tools.`;
  }
  return 'You do not have tool access; focus on reasoning and delegation.';
}

/**
 * Build the system prompt for an agent.
 *
 * @param role - The agent's role
 * @param maxDepth - Maximum delegation depth allowed
 * @param roles - All available roles for delegation
 * @returns System prompt string
 */
export function buildSystemPrompt(
  role: AgentRole,
  maxDepth: number,
  roles: AgentRole[],
  options: SystemPromptOptions,
): string {
  const roster = roles.join(', ');
  return [
    `You are the ${role} agent (${ROLE_BRIEFS[role]}).`,
    ROLE_GUIDELINES[role],
    options.allowDelegation
      ? `You can delegate to roles: ${roster}.`
      : 'Delegation is disabled for this request.',
    options.allowDelegation ? `You may delegate recursively up to depth ${maxDepth}.` : '',
    buildToolingLine(options.tooling),
    'Return JSON only. Do not wrap in code fences.',
    'Fields: summary (string), rationale (string, optional), notes (array of strings, optional),',
    'delegations (array of {role, objective, rationale?}), risks (array of strings, optional).',
    'Be SPECIFIC: include file paths, line numbers, function names. Avoid vague statements like "issues found".',
    'Prefer small, high-leverage delegations. Keep outputs terse but concrete.',
  ]
    .filter((line) => line.trim().length > 0)
    .join(' ');
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
    recent_session: trimSessionLog(sessionLog, 6),
  });
}

function trimSessionLog(entries: SessionLogEntry[], limit: number) {
  return entries.slice(-limit).map((entry) => ({
    role: entry.role,
    message: entry.message,
    timestamp: entry.timestamp,
    meta: summarizeSessionMeta(entry.meta),
  }));
}

function summarizeSessionMeta(meta?: Record<string, unknown>) {
  if (!meta) {
    return undefined;
  }
  const summary: Record<string, unknown> = {};
  if (typeof meta.type === 'string') {
    summary.type = meta.type;
  }
  if (typeof meta.tool === 'string') {
    summary.tool = meta.tool;
  }
  if (typeof meta.error === 'string') {
    summary.error = meta.error;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}
