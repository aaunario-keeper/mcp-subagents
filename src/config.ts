import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load env silently to avoid interfering with MCP stdio JSON-RPC handshake
dotenv.config({ quiet: true });

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');

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
  /** Directory for session data persistence */
  dataDir: process.env.AGENT_DATA_DIR ?? path.join(projectRoot, 'data'),
  /** Project root directory */
  projectRoot,
};
