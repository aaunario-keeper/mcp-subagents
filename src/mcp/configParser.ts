import fs from 'fs/promises';
import { parse } from 'smol-toml';
import { McpServerConfig } from './clientManager.js';

export interface CodexConfig {
  mcp_servers?: Record<
    string,
    {
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  >;
}

export interface CustomMcpServersConfig {
  servers?: Array<{
    name: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
  }>;
}

export async function parseCodexConfig(configPath: string): Promise<CodexConfig> {
  const content = await fs.readFile(configPath, 'utf8');
  const parsed = parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return {};
  }
  return parsed as CodexConfig;
}

export function extractMcpServers(config: CodexConfig): McpServerConfig[] {
  const servers = config.mcp_servers ?? {};
  const results: McpServerConfig[] = [];

  for (const [name, entry] of Object.entries(servers)) {
    const normalized = normalizeServerConfig({ name, ...entry });
    if (normalized) {
      results.push(normalized);
    }
  }

  return results;
}

export async function parseCustomServersConfig(
  configPath: string,
): Promise<McpServerConfig[]> {
  const content = await fs.readFile(configPath, 'utf8');
  const parsed = JSON.parse(content) as CustomMcpServersConfig;
  if (!parsed?.servers || !Array.isArray(parsed.servers)) {
    return [];
  }

  return parsed.servers
    .map((entry) => normalizeServerConfig(entry))
    .filter((entry): entry is McpServerConfig => Boolean(entry));
}

function normalizeServerConfig(
  entry: Partial<McpServerConfig> & { name?: string },
): McpServerConfig | null {
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  const command = typeof entry.command === 'string' ? entry.command.trim() : '';

  if (!name || !command) {
    return null;
  }

  const args = Array.isArray(entry.args)
    ? entry.args.filter((value) => typeof value === 'string')
    : [];

  const env =
    entry.env && typeof entry.env === 'object'
      ? Object.fromEntries(
          Object.entries(entry.env).map(([key, value]) => [
            key,
            typeof value === 'string' ? value : String(value),
          ]),
        )
      : undefined;

  return {
    name,
    command,
    args,
    env,
    cwd: entry.cwd,
  };
}
