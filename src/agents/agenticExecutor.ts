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

  /**
   * Retry synthesis when the model used tools but returned no final content.
   * Sends a follow-up prompt asking the model to synthesize its findings.
   */
  private async retrySynthesis(
    messages: ChatMessage[],
    options?: {
      apiKey?: string;
      model?: string;
      temperature?: number;
      responseFormat?: 'text' | 'json';
    },
  ): Promise<string | null> {
    const synthesisPrompt: ChatMessage = {
      role: 'user',
      content:
        'You executed tool calls but did not provide a final response. ' +
        'Based on the tool results above, provide your final JSON response with summary, notes, and any delegations. ' +
        'Do NOT call any more tools - just synthesize your findings.',
    };

    try {
      const result = await this.llm([...messages, synthesisPrompt], {
        model: options?.model,
        temperature: options?.temperature,
        responseFormat: options?.responseFormat ?? 'json',
        apiKey: options?.apiKey,
        tools: [], // No tools - force synthesis
        toolChoice: 'none',
      });

      if (typeof result.content === 'string' && result.content.trim().length > 0) {
        return result.content;
      }
    } catch (error) {
      // Synthesis retry failed, fall through to fallback
      console.error('Synthesis retry failed:', error instanceof Error ? error.message : error);
    }

    return null;
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
        // If we have tool history but no content, try a synthesis retry
        if (lastContent.trim().length === 0 && toolCallHistory.length > 0) {
          const synthesized = await this.retrySynthesis(messages, options);
          if (synthesized) {
            return {
              finalContent: synthesized,
              toolCallHistory,
              iterations: iteration + 1,
            };
          }
        }
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

    // Final synthesis retry if we have tool history but no content
    if (lastContent.trim().length === 0 && toolCallHistory.length > 0) {
      const synthesized = await this.retrySynthesis(messages, options);
      if (synthesized) {
        return {
          finalContent: synthesized,
          toolCallHistory,
          iterations: this.maxIterations,
        };
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

  // Analyze tool call results to provide a better fallback
  const successfulCalls = history.filter((e) => !e.error);
  const failedCalls = history.filter((e) => e.error);

  let summary: string;
  if (history.length === 0) {
    summary = 'Model returned empty response without using any tools.';
  } else if (failedCalls.length === history.length) {
    summary = `All ${failedCalls.length} tool call(s) failed. See errors below.`;
  } else if (successfulCalls.length > 0) {
    summary = `Executed ${successfulCalls.length} tool call(s) successfully but model did not synthesize results.`;
  } else {
    summary = 'Tool calls executed but the model returned no final answer.';
  }

  const notes: string[] = [];
  // Add successful results (limited)
  for (const entry of successfulCalls.slice(-3)) {
    notes.push(`Tool ${entry.tool} result: ${entry.result}`);
  }
  // Add error details
  for (const entry of failedCalls.slice(-2)) {
    notes.push(`Tool ${entry.tool} ERROR: ${entry.error}`);
  }
  if (notes.length === 0) {
    notes.push('No tool results to report. Consider retrying with a more specific objective.');
  }

  return toJsonSafe({ summary, notes, delegations: [] }, '');
}
