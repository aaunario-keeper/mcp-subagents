/** Available agent roles in the system */
export type AgentRole = 'planner' | 'code' | 'analysis';

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
}

/**
 * A chat message for LLM completions.
 */
export interface ChatMessage {
  /** Message role (system, user, or assistant) */
  role: 'system' | 'user' | 'assistant';
  /** Message content */
  content: string;
}

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
