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
  planner:
    'Prefer clear, staged plans and delegate only when it meaningfully helps.',
  code: 'ALWAYS use find_files or list_directory_tree BEFORE read_file to discover exact file paths. Do NOT try to read directories as files. Reference specific file:line in notes. NEVER claim to have made changes unless you actually used edit_file.',
  analysis:
    'Surface risks with specific file:line references and concrete evidence. ALWAYS use find_files first to discover file paths - never guess. Verify line numbers by reading the actual file.',
  research:
    'Cite sources with URLs or file:line references. Note uncertainty when information is incomplete. Only reference files and functions that actually exist in the project.',
  review:
    'Report issues as file:line with severity. ALWAYS use find_files to discover structure before reading files. Do NOT try to read directories as files. Verify all line numbers against actual file content.',
  test: 'Reference test files by path. Report pass/fail with specific file:line for failures. Only suggest test files for modules that actually exist in the project. Use find_files first.',
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
  /** Maximum delegations allowed per agent (for planner guidance) */
  maxDelegations?: number;
}

const TOOL_SELECTION_GUIDE = `
TOOL SELECTION WORKFLOW:
1. DISCOVER paths first: find_files(pattern) or list_directory_tree(path) - never guess paths
2. SEARCH content: grep_file(path, pattern) to find specific code
3. READ files: read_file(path) only after you know the exact path exists
4. MODIFY files: edit_file(path, find_text, replace_text) - requires exact text match
5. RUN commands: run_shell(command) for builds, tests, git operations

COMMON MISTAKES TO AVOID:
- Do NOT read_file on a directory - use list_directory_tree instead
- Do NOT guess file paths - use find_files first
- Do NOT claim edit success without checking edit_file returned success
- Do NOT search the entire project when you can narrow to a directory
`.trim();

function buildToolingLine(tooling: ToolingPrompt): string {
  if (tooling.status === 'available') {
    const summary = tooling.summary ? ` ${tooling.summary}` : '';
    const cwdNote = tooling.workingDirectory
      ? ` Working directory: ${tooling.workingDirectory}. Always use absolute paths or paths relative to this directory.`
      : '';
    return `Tool access is enabled.${summary}${cwdNote} Use tools to verify facts and avoid guessing.\n\n${TOOL_SELECTION_GUIDE}`;
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
  const delegationLimit = options.maxDelegations
    ? `Limit delegations to ${options.maxDelegations} per response (excess will be truncated).`
    : '';
  return [
    `You are the ${role} agent (${ROLE_BRIEFS[role]}).`,
    ROLE_GUIDELINES[role],
    options.allowDelegation
      ? `You can delegate to roles: ${roster}.`
      : 'Delegation is disabled for this request.',
    options.allowDelegation ? `You may delegate recursively up to depth ${maxDepth}.` : '',
    options.allowDelegation && delegationLimit ? delegationLimit : '',
    buildToolingLine(options.tooling),
    'Return JSON only. Do not wrap in code fences.',
    'Fields: summary (string), rationale (string, optional), notes (array of strings, optional),',
    'delegations (array of {role, objective, rationale?}), risks (array of strings, optional).',
    'Be SPECIFIC: include file paths, line numbers, function names. Avoid vague statements like "issues found".',
    'ANTI-HALLUCINATION: Do NOT claim to have modified/fixed code unless you used edit_file.',
    'Do NOT suggest files, services, or modules that do not exist in the project.',
    'If tool calls returned errors or no results, acknowledge the failure explicitly.',
    'After using tools, you MUST synthesize findings into a coherent summary - do not just return tool results.',
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
