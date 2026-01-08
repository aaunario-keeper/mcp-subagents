/** Available agent roles in the system */
export type AgentRole = 'planner' | 'code' | 'analysis' | 'research' | 'review' | 'test';

export type ToolAccessLevel = 'none' | 'read' | 'write' | 'execute' | 'admin';

export const TOOL_ACCESS_LEVELS: ToolAccessLevel[] = ['none', 'read', 'write', 'execute', 'admin'];

export const TOOL_ACCESS_LEVEL_ORDER: Record<ToolAccessLevel, number> = {
  none: 0,
  read: 1,
  write: 2,
  execute: 3,
  admin: 4,
};

/** Tool permissions per role (prefixed with server name). */
export const ROLE_TOOL_PERMISSIONS: Record<AgentRole, string[]> = {
  planner: [],
  code: [
    'smart-io:read_file',
    'smart-io:edit_file',
    'smart-io:create_file',
    'smart-io:run_shell',
  ],
  analysis: [
    'smart-io:read_file',
    'smart-io:grep_file',
    'smart-io:read_log',
    'smart-io:list_processes',
    'smart-io:list_directory_tree',
    'smart-io:find_files',
    'smart-io:run_shell',
    'smart-io:run_powershell',
  ],
  research: [
    '*:web_search',
    '*:web_fetch',
    'smart-io:read_file',
    'smart-io:grep_file',
    'keeper-memory*:*',
  ],
  review: [
    'smart-io:read_file',
    'smart-io:grep_file',
    'smart-io:syntax_check',
    'smart-io:check_git_status',
  ],
  test: ['smart-io:run_shell', 'smart-io:read_file', 'smart-io:create_file', 'smart-io:read_log'],
};

/** Default maximum tool access level per role. */
export const ROLE_TOOL_ACCESS_LEVELS: Record<AgentRole, ToolAccessLevel> = {
  planner: 'none',
  analysis: 'execute',
  research: 'read',
  review: 'read',
  code: 'execute',
  test: 'execute',
};

/** Which roles can use tools when available. */
export const TOOL_USING_ROLES: AgentRole[] = ['code', 'analysis', 'research', 'review', 'test'];

/** Roles that are not allowed to delegate to child agents.
 * Only 'planner' can delegate - all tool-using roles must focus on their task. */
export const NON_DELEGATING_ROLES: AgentRole[] = ['code', 'analysis', 'research', 'review', 'test'];

/**
 * Request to execute an agent with a specific role and objective.
 */
export interface AgentRequest {
  /** Role of the agent to execute */
  role: AgentRole;
  /** Primary objective/task for the agent */
  objective: string;
  /** Optional additional context to inform the agent */
  context?: string;
  /** Optional OpenAI API key override for this request (not persisted) */
  apiKey?: string;
  /** Session ID for scratchpad persistence (defaults to 'default') */
  sessionId?: string;
  /** Current recursion depth (internal use) */
  depth?: number;
  /** Maximum allowed recursion depth */
  maxDepth?: number;
  /** Maximum delegations per agent response (overrides config default) */
  maxDelegations?: number;
  /** Model to use (overrides config default, e.g., 'gpt-4o' for better reasoning) */
  model?: string;
}

/**
 * A delegation request from one agent to another.
 */
export interface AgentDelegation {
  /** Target agent role */
  role: AgentRole;
  /** Objective for the delegated agent */
  objective: string;
  /** Optional rationale for why this delegation was made */
  rationale?: string;
}

/**
 * Result of an agent execution, including any delegated child results.
 */
export interface AgentResult {
  /** Role of the agent that produced this result */
  role: AgentRole;
  /** Summary of the agent's work */
  summary: string;
  /** Optional rationale for the approach taken */
  rationale?: string;
  /** Optional notes or observations */
  notes?: string[];
  /** Optional identified risks or concerns */
  risks?: string[];
  /** Delegations that were requested */
  delegations: AgentDelegation[];
  /** Results from delegated child agents */
  children: AgentResult[];
  /** Raw LLM response (for debugging) */
  raw?: string;
  /** Token usage for this agent (excluding children) */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * A chat message for LLM completions.
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type ChatMessage =
  | {
      /** Message role */
      role: 'system' | 'user';
      /** Message content */
      content: string;
    }
  | {
      role: 'assistant';
      content: string | null;
      toolCalls?: ToolCall[];
    }
  | {
      role: 'tool';
      content: string;
      toolCallId: string;
    };

/**
 * Entry in the session log/scratchpad.
 */
export interface SessionLogEntry {
  /** Role that created this entry */
  role: string;
  /** Message content */
  message: string;
  /** ISO timestamp of when the entry was created */
  timestamp: string;
  /** Optional metadata */
  meta?: Record<string, unknown>;
}
