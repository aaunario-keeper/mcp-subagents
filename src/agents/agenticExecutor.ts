import { CompletionOptions, CompletionResult } from '../llm/provider.js';
import { ToolRegistry } from '../mcp/toolRegistry.js';
import { AgentRole, ChatMessage } from '../types.js';
import { toJsonSafe } from '../utils/json.js';

interface ExecutorOptions {
  llm: (messages: ChatMessage[], options?: CompletionOptions) => Promise<CompletionResult>;
  toolRegistry: ToolRegistry;
  maxIterations?: number;
  maxToolCallsPerIteration?: number;
  hasDefaultApiKey?: boolean;
}

interface ToolCallHistoryEntry {
  tool: string;
  args: Record<string, unknown>;
  result: string;
  error?: string;
}

export interface ExecutionResult {
  finalContent: string;
  toolCallHistory: ToolCallHistoryEntry[];
  iterations: number;
}

export class AgenticExecutor {
  private llm: (messages: ChatMessage[], options?: CompletionOptions) => Promise<CompletionResult>;
  private toolRegistry: ToolRegistry;
  private maxIterations: number;
  private maxToolCallsPerIteration: number;
  private hasDefaultApiKey: boolean;

  constructor(options: ExecutorOptions) {
    this.llm = options.llm;
    this.toolRegistry = options.toolRegistry;
    this.maxIterations = options.maxIterations ?? 10;
    this.maxToolCallsPerIteration = options.maxToolCallsPerIteration ?? 5;
    this.hasDefaultApiKey = options.hasDefaultApiKey ?? false;
  }

  canExecuteWithTools(apiKeyOverride?: string): boolean {
    return Boolean(apiKeyOverride) || this.hasDefaultApiKey;
  }

  async execute(
    systemPrompt: string,
    userMessage: string,
    role: AgentRole,
    options?: {
      apiKey?: string;
      model?: string;
      temperature?: number;
      responseFormat?: 'text' | 'json';
      toolChoice?: 'auto' | 'required' | 'none';
    },
  ): Promise<ExecutionResult> {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    const toolCallHistory: ToolCallHistoryEntry[] = [];
    let lastContent = '';

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const tools = this.toolRegistry.toOpenAiFunctions(role);
      const requestedToolChoice =
        options?.toolChoice && tools.length > 0 ? options.toolChoice : undefined;
      const forceInitialTool =
        requestedToolChoice === 'required' && toolCallHistory.length === 0;
      const toolChoice =
        requestedToolChoice === 'required'
          ? forceInitialTool
            ? 'required'
            : 'auto'
          : requestedToolChoice;
      const result = await this.llm(messages, {
        model: options?.model,
        temperature: options?.temperature,
        responseFormat: options?.responseFormat ?? 'json',
        apiKey: options?.apiKey,
        tools,
        toolChoice: toolChoice ?? (tools.length > 0 ? 'auto' : 'none'),
      });

      if (typeof result.content === 'string') {
        lastContent = result.content;
      }

      const toolCalls = result.toolCalls ?? [];
      if (result.finishReason === 'stop' || toolCalls.length === 0) {
        const fallback = buildFallbackContent(options?.responseFormat, toolCallHistory);
        return {
          finalContent: lastContent.trim().length > 0 ? lastContent : fallback,
          toolCallHistory,
          iterations: iteration + 1,
        };
      }

      const boundedToolCalls = toolCalls.slice(0, this.maxToolCallsPerIteration);
      messages.push({ role: 'assistant', content: result.content ?? null, toolCalls: boundedToolCalls });

      for (const call of boundedToolCalls) {
        let parsedArgs: Record<string, unknown> = {};
        let resultText = '';
        let errorMessage: string | undefined;

        try {
          parsedArgs = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch (error) {
          errorMessage = `Invalid JSON arguments: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }

        if (!errorMessage) {
          try {
            const toolResult = await this.toolRegistry.execute(call.function.name, parsedArgs);
            resultText = toJsonSafe(toolResult, '');
          } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error);
          }
        }

        const finalText = errorMessage ? `Error: ${errorMessage}` : resultText;
        messages.push({ role: 'tool', toolCallId: call.id, content: finalText });
        const resolvedName =
          this.toolRegistry.resolveToolName(call.function.name) ?? call.function.name;
        toolCallHistory.push({
          tool: resolvedName,
          args: parsedArgs,
          result: truncateText(finalText),
          error: errorMessage,
        });
      }
    }

    const fallback = buildFallbackContent(options?.responseFormat, toolCallHistory);
    return {
      finalContent: lastContent.trim().length > 0 ? lastContent : fallback,
      toolCallHistory,
      iterations: this.maxIterations,
    };
  }
}

function truncateText(value: string, limit = 1500): string {
  if (value.length <= limit) {
    return value;
  }
  const truncated = value.slice(0, limit);
  return `${truncated}... [truncated ${value.length - limit} chars]`;
}

function buildFallbackContent(
  format: 'text' | 'json' | undefined,
  history: ToolCallHistoryEntry[],
): string {
  if (format !== 'json') {
    return 'No response content returned.';
  }
  const summary =
    history.length > 0
      ? 'Tool calls executed but the model returned no final answer.'
      : 'Model returned empty response.';
  const notes =
    history.length > 0
      ? history.slice(-3).map((entry) => `Tool ${entry.tool} result: ${entry.result}`)
      : ['Retry the request.'];
  return toJsonSafe({ summary, notes, delegations: [] }, '');
}
