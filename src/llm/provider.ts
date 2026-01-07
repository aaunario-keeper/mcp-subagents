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
 * LLM provider that uses MCP's sampling capability.
 * Delegates completion requests to the MCP client.
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

  /**
   * Send a completion request via MCP sampling.
   *
   * @param messages - Array of chat messages (system, user, assistant)
   * @param options - Optional completion parameters
   * @returns The assistant's response content
   * @throws Error if sampling fails or returns no content
   */
  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    // Convert messages to MCP sampling format
    const systemPrompt = messages.find((m) => m.role === 'system')?.content;
    const samplingMessages = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: { type: 'text' as const, text: m.content },
      }));

    const result = await this.server.server.createMessage({
      messages: samplingMessages,
      systemPrompt,
      modelPreferences: {
        hints: [{ name: options?.model ?? this.defaultModel }],
      },
      maxTokens: options?.maxTokens ?? 4096,
    });

    if (result.content.type !== 'text') {
      throw new Error('MCP sampling returned non-text content');
    }

    return result.content.text;
  }
}
