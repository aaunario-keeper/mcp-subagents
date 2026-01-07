import { ChatMessage } from '../types.js';

/** Default timeout for LLM API requests in milliseconds */
const DEFAULT_TIMEOUT_MS = 60_000;

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  responseFormat?: 'text' | 'json';
  maxTokens?: number;
  /** Request timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
}

/**
 * Interface for LLM providers that can generate completions.
 */
export interface LLMProvider {
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
}

/** Response structure from OpenAI-compatible APIs */
interface OpenAIResponse {
  choices: Array<{
    message?: {
      content?: string;
    };
  }>;
}

/**
 * OpenAI-compatible LLM provider.
 * Supports any API that implements the OpenAI chat completions interface.
 */
export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private defaultTemperature: number;

  constructor(opts: { apiKey: string; baseUrl: string; model: string; temperature?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.defaultModel = opts.model;
    this.defaultTemperature = opts.temperature ?? 0.2;
  }

  /**
   * Send a chat completion request to the LLM.
   *
   * @param messages - Array of chat messages (system, user, assistant)
   * @param options - Optional completion parameters
   * @returns The assistant's response content
   * @throws Error if the request times out, fails, or returns no content
   */
  async complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const body = {
      model: options?.model ?? this.defaultModel,
      temperature: options?.temperature ?? this.defaultTemperature,
      messages: messages.map((msg) => ({ role: msg.role, content: msg.content })),
      response_format: options?.responseFormat === 'json' ? { type: 'json_object' as const } : undefined,
      max_tokens: options?.maxTokens,
    };

    try {
      const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(`LLM request failed (${response.status}): ${detail}`);
      }

      const data = (await response.json()) as OpenAIResponse;

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('LLM response missing content.');
      }

      return content;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`LLM request timed out after ${timeoutMs}ms`);
      }

      throw error;
    }
  }
}
