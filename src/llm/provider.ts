import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ChatMessage } from '../types.js';

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  maxTokens?: number;
}

/**
 * Interface for LLM providers that can generate completions.
 */
export interface LLMProvider {
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
}

/**
 * LLM provider that delegates sampling to the MCP client (no API key needed).
 * Uses the MCP sampling/createMessage capability.
 */
export class McpSamplingProvider implements LLMProvider {
  private server: McpServer;
  private defaultModel: string;
  private defaultTemperature: number;

  constructor(server: McpServer, opts: { model: string; temperature?: number }) {
    this.server = server;
    this.defaultModel = opts.model;
    this.defaultTemperature = opts.temperature ?? 0.2;
  }

  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    // Extract system prompt (MCP sampling uses systemPrompt field, not a system message)
    const systemPrompt = messages.find((m) => m.role === 'system')?.content;

    // Convert non-system messages to MCP format (only user/assistant allowed)
    const mcpMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: { type: 'text' as const, text: m.content },
      }));

    // Call the underlying Server's createMessage (McpServer.server is the Server instance)
    const result = await this.server.server.createMessage({
      messages: mcpMessages,
      systemPrompt,
      modelPreferences: {
        hints: [{ name: options?.model ?? this.defaultModel }],
      },
      temperature: options?.temperature ?? this.defaultTemperature,
      maxTokens: options?.maxTokens ?? 4096,
    });

    // Extract text from result content
    const content = result.content;
    let text: string;

    if (content.type === 'text') {
      text = content.text;
    } else {
      throw new Error(`MCP sampling returned unsupported content type: ${content.type}`);
    }

    if (!text.trim()) {
      throw new Error('MCP client returned empty text content from createMessage.');
    }

    return text;
  }
}
