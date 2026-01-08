import dotenv from 'dotenv';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  AgentRole,
  ROLE_TOOL_ACCESS_LEVELS,
  TOOL_ACCESS_LEVELS,
  ToolAccessLevel,
} from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

// Load env silently from project root to avoid cwd surprises.
dotenv.config({ quiet: true, path: path.join(projectRoot, '.env'), override: true });

/**
 * Parse a positive integer from an environment variable.
 * Returns the default value if parsing fails or the value is invalid.
 */
function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    console.error(`Invalid integer value "${value}", using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse a non-negative integer from an environment variable.
 * Returns the default value if parsing fails or the value is invalid.
 */
function parseNonNegativeInt(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`Invalid integer value "${value}", using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse a float from an environment variable.
 * Returns the default value if parsing fails.
 */
function parseFloat(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    console.error(`Invalid float value "${value}", using default: ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function parseRoleAccessLevels(value: string | undefined): Record<AgentRole, ToolAccessLevel> {
  const defaults = { ...ROLE_TOOL_ACCESS_LEVELS };
  if (!value) {
    return defaults;
  }

  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const [roleRaw, levelRaw] = entry.split('=').map((part) => part.trim());
    const role = roleRaw as AgentRole;
    const level = levelRaw as ToolAccessLevel;
    if (!role || !(role in defaults)) {
      console.error(`Unknown role in AGENT_TOOL_ACCESS_LEVELS: "${entry}"`);
      continue;
    }
    if (!TOOL_ACCESS_LEVELS.includes(level)) {
      console.error(`Unknown tool access level in AGENT_TOOL_ACCESS_LEVELS: "${entry}"`);
      continue;
    }
    defaults[role] = level;
  }

  return defaults;
}

/**
 * Application configuration loaded from environment variables.
 */
export const CONFIG = {
  /** Preferred model name to request from the MCP client */
  model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  /** Maximum recursion depth for agent delegation (1-8) */
  defaultMaxDepth: Math.min(8, Math.max(1, parsePositiveInt(process.env.AGENT_MAX_DEPTH, 3))),
  /** Temperature hint for LLM completions (0-2) */
  temperature: Math.min(2, Math.max(0, parseFloat(process.env.AGENT_TEMPERATURE, 0.2))),
  /** Path to Codex config for MCP server discovery */
  codexConfigPath:
    process.env.CODEX_CONFIG_PATH ?? path.join(os.homedir(), '.codex', 'config.toml'),
  /** Optional custom MCP servers config path (JSON) */
  mcpServersConfigPath: process.env.MCP_SERVERS_CONFIG,
  /** Optional allowlist of MCP server names */
  mcpServersAllowlist: (process.env.MCP_SERVERS_ALLOWLIST ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  /** Maximum number of tool-using iterations per agent */
  maxAgentIterations: parsePositiveInt(process.env.AGENT_MAX_ITERATIONS, 10),
  /** Maximum number of tool calls per iteration */
  maxToolCallsPerIteration: parsePositiveInt(process.env.AGENT_MAX_TOOL_CALLS, 5),
  /** Maximum delegations allowed per agent response (prevents exponential branching) */
  maxDelegationsPerAgent: parsePositiveInt(process.env.AGENT_MAX_DELEGATIONS, 2),
  /** Maximum tool access level per role */
  toolAccessLevels: parseRoleAccessLevels(process.env.AGENT_TOOL_ACCESS_LEVELS),
  /** Timeout for MCP tool calls (milliseconds) */
  mcpToolTimeoutMs: parsePositiveInt(process.env.MCP_TOOL_TIMEOUT_MS, 60_000),
  /** Timeout for MCP tool discovery (milliseconds) */
  mcpListToolsTimeoutMs: parsePositiveInt(process.env.MCP_LIST_TOOLS_TIMEOUT_MS, 30_000),
  /** Retry count for throttled MCP tool calls */
  mcpToolRetries: parseNonNegativeInt(process.env.MCP_TOOL_RETRIES, 1),
  /** Base delay between MCP tool retries (milliseconds) */
  mcpToolRetryDelayMs: parseNonNegativeInt(process.env.MCP_TOOL_RETRY_DELAY_MS, 250),
  /** Directory for session data persistence */
  dataDir: process.env.AGENT_DATA_DIR ?? path.join(projectRoot, 'data'),
  /** Project root directory */
  projectRoot,
  /** Maximum total agents allowed per session (prevents exponential spawning) */
  maxAgentsPerSession: parsePositiveInt(process.env.AGENT_MAX_TOTAL, 100),
  /** Maximum session log size in bytes before truncation */
  maxSessionLogBytes: parsePositiveInt(process.env.AGENT_SESSION_LOG_MAX_BYTES, 1_000_000),
};
