import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ConnectedServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: Tool[];
}

const CLIENT_INFO = { name: 'mcp-subagents', version: '0.1.0' };
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_LIST_TIMEOUT_MS = 30_000;
const DEFAULT_TOOL_RETRIES = 1;
const DEFAULT_TOOL_RETRY_DELAY_MS = 250;

export interface McpClientManagerOptions {
  toolCallTimeoutMs?: number;
  listToolsTimeoutMs?: number;
  toolCallRetries?: number;
  toolCallRetryDelayMs?: number;
}

function prefixToolName(server: string, toolName: string): string {
  return `${server}:${toolName}`;
}

function toEnvRecord(env: NodeJS.ProcessEnv): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      record[key] = value;
    }
  }
  return record;
}

export class McpClientManager {
  private servers: Map<string, ConnectedServer> = new Map();
  private toolCallTimeoutMs: number;
  private listToolsTimeoutMs: number;
  private toolCallRetries: number;
  private toolCallRetryDelayMs: number;

  constructor(options?: McpClientManagerOptions) {
    this.toolCallTimeoutMs = options?.toolCallTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.listToolsTimeoutMs = options?.listToolsTimeoutMs ?? DEFAULT_LIST_TIMEOUT_MS;
    this.toolCallRetries = Math.max(0, options?.toolCallRetries ?? DEFAULT_TOOL_RETRIES);
    this.toolCallRetryDelayMs = Math.max(
      0,
      options?.toolCallRetryDelayMs ?? DEFAULT_TOOL_RETRY_DELAY_MS,
    );
  }

  async connect(config: McpServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      return;
    }

    const env = config.env ? { ...toEnvRecord(process.env), ...config.env } : undefined;
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env,
      cwd: config.cwd,
    });

    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(transport);
    } catch (error) {
      try {
        await client.close();
      } catch {}
      try {
        await transport.close();
      } catch {}
      throw error;
    }

    let tools: Tool[] = [];
    try {
      tools = await this.listAllTools(client);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to list tools for MCP server "${config.name}": ${message}`);
    }
    this.servers.set(config.name, { name: config.name, client, transport, tools });
  }

  async connectAll(configs: McpServerConfig[]): Promise<void> {
    for (const config of configs) {
      try {
        await this.connect(config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to connect to MCP server "${config.name}": ${message}`);
      }
    }
  }

  async refreshTools(): Promise<void> {
    for (const server of this.servers.values()) {
      try {
        server.tools = await this.listAllTools(server.client);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Failed to refresh tools for "${server.name}": ${message}`);
      }
    }
  }

  getAllTools(): Map<string, { server: string; tool: Tool }> {
    const aggregated = new Map<string, { server: string; tool: Tool }>();
    for (const [serverName, server] of this.servers.entries()) {
      for (const tool of server.tools) {
        aggregated.set(prefixToolName(serverName, tool.name), {
          server: serverName,
          tool,
        });
      }
    }
    return aggregated;
  }

  getServerSummary(): Array<{ name: string; toolCount: number }> {
    return Array.from(this.servers.values()).map((server) => ({
      name: server.name,
      toolCount: server.tools.length,
    }));
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const resolved = this.resolveTool(toolName);
    if (!resolved) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const { serverName, tool } = resolved;
    const server = this.servers.get(serverName);
    if (!server) {
      throw new Error(`MCP server not connected: ${serverName}`);
    }

     return callWithRetry(
       () =>
         withTimeout(
           server.client.callTool({ name: tool.name, arguments: args }),
           this.toolCallTimeoutMs,
           `tool call ${serverName}:${tool.name}`,
         ),
       this.toolCallRetries,
       this.toolCallRetryDelayMs,
     );
  }

  async disconnectAll(): Promise<void> {
    const servers = Array.from(this.servers.values());
    this.servers.clear();
    for (const server of servers) {
      try {
        await server.client.close();
      } catch {}
      try {
        await server.transport.close();
      } catch {}
    }
  }

  private resolveTool(toolName: string): { serverName: string; tool: Tool } | null {
    const [serverName, name] = toolName.split(':');
    if (!serverName || !name) {
      return null;
    }
    const server = this.servers.get(serverName);
    if (!server) {
      return null;
    }
    const tool = server.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return null;
    }
    return { serverName, tool };
  }

  private async listAllTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
     do {
       const result = await withTimeout(
         client.listTools(cursor ? { cursor } : undefined),
         this.listToolsTimeoutMs,
         'listTools',
       );
       tools.push(...result.tools);
       cursor = result.nextCursor;
     } while (cursor);
     return tools;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

async function callWithRetry<T>(
  operation: () => Promise<T>,
  retries: number,
  delayMs: number,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= retries || !isThrottlingError(error)) {
        throw error;
      }
      attempt += 1;
      if (delayMs > 0) {
        await delay(delayMs * attempt);
      }
    }
  }
}

function isThrottlingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /throttled|rate limit|429/i.test(message);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
