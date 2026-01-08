import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'fs';
import * as http from 'http';
import * as https from 'https';
import { ChatMessage, ToolCall } from '../types.js';

/** JSON format instruction to append to system prompts */
const JSON_FORMAT_INSTRUCTION =
  'IMPORTANT: You must respond with valid JSON only. No markdown, no code fences, just raw JSON.';

function loadExtraCa(): Buffer | undefined {
  const caPath = process.env.NODE_EXTRA_CA_CERTS;
  if (!caPath) return undefined;
  try {
    return readFileSync(caPath);
  } catch (error) {
    console.error(
      `Failed to read NODE_EXTRA_CA_CERTS at "${caPath}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  extraCa?: Buffer,
): Promise<{ status: number; payload: unknown }> {
  const payload = JSON.stringify(body);
  const urlObject = new URL(url);
  const isHttps = urlObject.protocol === 'https:';
  const requestFn = isHttps ? https.request : http.request;

  const options: https.RequestOptions = {
    method: 'POST',
    protocol: urlObject.protocol,
    hostname: urlObject.hostname,
    port: urlObject.port,
    path: `${urlObject.pathname}${urlObject.search}`,
    headers: {
      ...headers,
      'Content-Length': Buffer.byteLength(payload).toString(),
    },
  };

  if (isHttps && extraCa) {
    options.ca = extraCa;
  }

  return new Promise((resolve, reject) => {
    const request = requestFn(options, (response) => {
      let bodyText = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        bodyText += chunk;
      });
      response.on('end', () => {
        let parsed: unknown = {};
        if (bodyText) {
          try {
            parsed = JSON.parse(bodyText);
          } catch {
            parsed = {};
          }
        }
        resolve({ status: response.statusCode ?? 0, payload: parsed });
      });
    });

    request.on('error', reject);
    request.write(payload);
    request.end();
  });
}

export interface CompletionOptions {
  model?: string;
  temperature?: number;
  /**
   * Preferred response format hint.
   * Note: MCP sampling doesn't support response_format natively.
   * JSON formatting is requested by appending instructions to the system prompt.
   */
  responseFormat?: 'text' | 'json';
  maxTokens?: number;
  /** Optional OpenAI API key override for direct fallback. */
  apiKey?: string;
  /** OpenAI function calling tool definitions. */
  tools?: object[];
  toolChoice?:
    | 'auto'
    | 'required'
    | 'none'
    | { type: 'function'; function: { name: string } };
}

export interface CompletionResult {
  content: string | null;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length';
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

function appendJsonInstruction(
  messages: ChatMessage[],
  responseFormat?: 'text' | 'json',
): ChatMessage[] {
  if (responseFormat !== 'json') {
    return messages;
  }

  const hasInstruction = messages.some(
    (message) => message.role === 'system' && message.content.includes(JSON_FORMAT_INSTRUCTION),
  );
  if (hasInstruction) {
    return messages;
  }

  const systemIndex = messages.findIndex((message) => message.role === 'system');
  const updated = messages.map((message) => ({ ...message }));

  if (systemIndex >= 0 && updated[systemIndex].role === 'system') {
    updated[systemIndex] = {
      ...updated[systemIndex],
      content: `${updated[systemIndex].content}\n\n${JSON_FORMAT_INSTRUCTION}`,
    };
    return updated;
  }

  return [{ role: 'system', content: JSON_FORMAT_INSTRUCTION }, ...updated];
}

function isSamplingMethodMissing(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = 'message' in error ? String(error.message) : '';
  const code = 'code' in error ? String(error.code) : '';
  const combined = `${code} ${message}`.toLowerCase();
  return (
    combined.includes('sampling/createmessage') ||
    combined.includes('method not found') ||
    combined.includes('-32601')
  );
}

/**
 * Interface for LLM providers that can generate completions.
 */
export interface LLMProvider {
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<CompletionResult>;
}

interface DirectOpenAiOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  defaultTemperature: number;
}

export class DirectOpenAiProvider implements LLMProvider {
  private apiKey?: string;
  private baseUrl: string;
  private defaultModel: string;
  private defaultTemperature: number;
  private extraCa?: Buffer;

  constructor(options: DirectOpenAiOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.defaultModel = options.defaultModel;
    this.defaultTemperature = options.defaultTemperature;
    this.extraCa = loadExtraCa();
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const apiKey = options?.apiKey ?? this.apiKey;
    if (!apiKey) {
      throw new Error(
        'OpenAI API key is missing. Set OPENAI_API_KEY or pass apiKey in tool options.',
      );
    }
    const preparedMessages = appendJsonInstruction(messages, options?.responseFormat);
    const body = {
      model: options?.model ?? this.defaultModel,
      messages: preparedMessages.map((message) => {
        if (message.role === 'tool') {
          return {
            role: 'tool',
            content: message.content,
            tool_call_id: message.toolCallId,
          };
        }
        if (message.role === 'assistant' && message.toolCalls) {
          return {
            role: 'assistant',
            content: message.content,
            tool_calls: message.toolCalls,
          };
        }
        return {
          role: message.role,
          content: message.content,
        };
      }),
      temperature: options?.temperature ?? this.defaultTemperature,
      max_tokens: options?.maxTokens ?? 4096,
      response_format: options?.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      tools: options?.tools,
      tool_choice: options?.toolChoice,
    };

    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const { status, payload } = await postJson(
      url,
      body,
      {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      this.extraCa,
    );

    if (status < 200 || status >= 300) {
      const errorMessage =
        (payload as { error?: { message?: string }; message?: string })?.error
          ?.message ??
        (payload as { message?: string })?.message ??
        `OpenAI request failed with status ${status}`;
      throw new Error(errorMessage);
    }

    const typed = payload as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: ToolCall[] };
        finish_reason?: 'stop' | 'tool_calls' | 'length';
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = typed?.choices?.[0];
    const message = choice?.message;
    const content = message?.content ?? null;
    const toolCalls = message?.tool_calls;
    const finishReason = choice?.finish_reason ?? 'stop';
    const rawUsage = typed?.usage;

    if (content === null && (!toolCalls || toolCalls.length === 0)) {
      throw new Error('OpenAI response missing text content.');
    }

    return {
      content: typeof content === 'string' ? content : null,
      toolCalls,
      finishReason,
      usage: rawUsage
        ? { promptTokens: rawUsage.prompt_tokens ?? 0, completionTokens: rawUsage.completion_tokens ?? 0 }
        : undefined,
    };
  }
}

/**
 * LLM provider that delegates sampling to the MCP client (no API key needed).
 * Uses the MCP sampling/createMessage capability.
 *
 * Note: MCP sampling doesn't support response_format. To get JSON output,
 * this provider appends JSON formatting instructions to the system prompt.
 */
export class McpSamplingProvider implements LLMProvider {
  private server: McpServer;
  private defaultModel: string;
  private defaultTemperature: number;
  private fallback?: LLMProvider;

  constructor(
    server: McpServer,
    opts: { model: string; temperature?: number; fallback?: LLMProvider },
  ) {
    this.server = server;
    this.defaultModel = opts.model;
    this.defaultTemperature = opts.temperature ?? 0.2;
    this.fallback = opts.fallback;
  }

  async complete(
    messages: ChatMessage[],
    options?: CompletionOptions,
  ): Promise<CompletionResult> {
    const preparedMessages = appendJsonInstruction(messages, options?.responseFormat);
    // Extract system prompt (MCP sampling uses systemPrompt field, not a system message)
    const systemPrompt = preparedMessages.find(
      (m): m is { role: 'system'; content: string } => m.role === 'system',
    )?.content;

    // Convert non-system messages to MCP format (only user/assistant allowed)
    const mcpMessages = preparedMessages
      .filter(
        (m): m is { role: 'user' | 'assistant'; content: string } =>
          (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
      )
      .map((m) => ({
        role: m.role,
        content: { type: 'text' as const, text: m.content },
      }));

    // Call the underlying Server's createMessage (McpServer.server is the Server instance)
    let result: Awaited<ReturnType<typeof this.server.server.createMessage>>;
    try {
      result = await this.server.server.createMessage({
        messages: mcpMessages,
        systemPrompt,
        modelPreferences: {
          hints: [{ name: options?.model ?? this.defaultModel }],
        },
        temperature: options?.temperature ?? this.defaultTemperature,
        maxTokens: options?.maxTokens ?? 4096,
      });
    } catch (error) {
      if (this.fallback && isSamplingMethodMissing(error)) {
        const canFallback =
          Boolean(options?.apiKey) ||
          (this.fallback instanceof DirectOpenAiProvider && this.fallback.hasApiKey());
        if (canFallback) {
          return this.fallback.complete(preparedMessages, options);
        }
        throw new Error(
          'MCP client does not support sampling and no OpenAI API key was provided for fallback.',
        );
      }
      throw error;
    }

    // Extract text from result content
    const content = result.content;
    let text: string | undefined;

    if (Array.isArray(content)) {
      const textItem = content.find(
        (item) => typeof item === 'object' && item !== null && 'type' in item && item.type === 'text',
      );
      if (textItem && typeof textItem.text === 'string') {
        text = textItem.text;
      }
    } else if (content.type === 'text') {
      text = content.text;
    } else {
      throw new Error(`MCP sampling returned unsupported content type: ${content.type}`);
    }

    if (!text || !text.trim()) {
      throw new Error('MCP client returned empty text content from createMessage.');
    }

    return { content: text, finishReason: 'stop' };
  }
}

export function createDefaultProvider(
  server: McpServer,
  opts: { model: string; temperature?: number },
) {
  const fallback = new DirectOpenAiProvider({
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    defaultModel: opts.model,
    defaultTemperature: opts.temperature ?? 0.2,
  });

  return new McpSamplingProvider(server, { ...opts, fallback });
}
