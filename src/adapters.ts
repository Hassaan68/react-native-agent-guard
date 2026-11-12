import type { z } from 'zod';
import type { ToolRegistry } from './registry';
import type { ToolExecutionResult } from './types';

/**
 * Options for configuring the Vercel AI SDK adapter (`toVercelAITools`).
 */
export interface VercelAIAdapterOptions {
  /**
   * When `true`, `execute()` returns `result.data` directly on success instead of the full `ToolExecutionResult` envelope.
   * On failure/denial, it still returns `{ error: result.code, llmFeedback: result.llmFeedback }` unless `throwOnError` is `true`.
   * Defaults to `false`.
   */
  unwrapData?: boolean;
  /**
   * When `true`, throws an `Error(result.llmFeedback)` if a tool execution is denied or fails validation.
   * Defaults to `false` so the LLM can receive `llmFeedback` and self-correct.
   */
  throwOnError?: boolean;
}

/**
 * Tool definition compatible with the Vercel AI SDK (`generateText`, `streamText`, `useChat`).
 */
export interface VercelAIToolDefinition<
  TSchema extends z.ZodType = z.ZodType,
  TOutput = unknown,
> {
  /** Human and LLM readable description of the tool. */
  description: string;
  /** Zod schema used by the Vercel AI SDK (v3/v4 `parameters`). */
  parameters: TSchema;
  /** Zod schema alias used by Vercel AI SDK v5 (`inputSchema`). */
  inputSchema: TSchema;
  /**
   * Execution handler automatically routed through `GuardrailRegistry.execute()`
   * (enforcing Zod validation, `'confirm'` approval sheets, `'biometric'` prompts, timeouts, and `onAudit` telemetry).
   */
  execute: (
    args: z.infer<TSchema>,
    options?: unknown,
  ) => Promise<ToolExecutionResult<TOutput> | TOutput | Record<string, unknown>>;
}

/**
 * Options for configuring the LangChain.js adapter (`toLangChainTools`).
 */
export interface LangChainAdapterOptions {
  /**
   * When `true`, `.invoke()` and `.call()` return `result.data` directly on success.
   * Defaults to `false` (returns the full `ToolExecutionResult`).
   */
  unwrapData?: boolean;
  /**
   * When `true`, throws an `Error(result.llmFeedback)` when execution is denied or fails.
   * Defaults to `false`.
   */
  throwOnError?: boolean;
}

/**
 * Tool definition compatible with LangChain.js (`DynamicStructuredTool`, `StructuredToolInterface`, `ToolNode`, `bindTools`).
 */
export interface LangChainToolDefinition<
  TSchema extends z.ZodType = z.ZodType,
  TOutput = unknown,
> {
  /** Tool name identifier. */
  name: string;
  /** Human and LLM readable description of the tool. */
  description: string;
  /** Zod input schema used by LangChain's structured tool runner. */
  schema: TSchema;
  /**
   * String-returning function compatible with `new DynamicStructuredTool({ name, description, schema, func })`.
   * Automatically routes through `GuardrailRegistry.execute()` and serializes the result or `llmFeedback` for `ToolMessage`.
   */
  func: (input: z.infer<TSchema>) => Promise<string>;
  /**
   * Runnable-compatible `.invoke()` method routing through `GuardrailRegistry.execute()`.
   */
  invoke: (
    input: z.infer<TSchema>,
  ) => Promise<ToolExecutionResult<TOutput> | TOutput>;
  /**
   * `StructuredTool`-compatible `.call()` method routing through `GuardrailRegistry.execute()`.
   */
  call: (
    input: z.infer<TSchema>,
  ) => Promise<ToolExecutionResult<TOutput> | TOutput>;
}

/**
 * Convert all tools registered in a `ToolRegistry` / `GuardrailRegistry` into a
 * `Record<string, VercelAIToolDefinition>` map compatible with the Vercel AI SDK (`generateText`, `streamText`).
 */
export function toVercelAITools(
  registry: ToolRegistry,
  options: VercelAIAdapterOptions = {},
): Record<string, VercelAIToolDefinition> {
  const result: Record<string, VercelAIToolDefinition> = {};

  for (const name of registry.getToolNames()) {
    const tool = registry.getTool(name);
    if (!tool) {
      continue;
    }

    result[name] = {
      description: tool.description,
      parameters: tool.inputSchema,
      inputSchema: tool.inputSchema,
      execute: async (args: unknown) => {
        const execResult = await registry.execute(name, args);

        if (!execResult.success) {
          if (options.throwOnError) {
            throw new Error(
              execResult.llmFeedback ??
                execResult.error?.message ??
                `Tool "${name}" failed with code ${execResult.code}`,
            );
          }
          if (options.unwrapData) {
            return {
              success: false,
              error: execResult.code,
              llmFeedback: execResult.llmFeedback,
            };
          }
          return execResult;
        }

        return options.unwrapData ? execResult.data : execResult;
      },
    };
  }

  return result;
}

/**
 * Convert all tools registered in a `ToolRegistry` / `GuardrailRegistry` into an
 * array of `LangChainToolDefinition` objects compatible with LangChain.js (`DynamicStructuredTool`, `ToolNode`, `bindTools`).
 */
export function toLangChainTools(
  registry: ToolRegistry,
  options: LangChainAdapterOptions = {},
): LangChainToolDefinition[] {
  const tools: LangChainToolDefinition[] = [];

  for (const name of registry.getToolNames()) {
    const tool = registry.getTool(name);
    if (!tool) {
      continue;
    }

    const runGuarded = async (input: unknown) => {
      const execResult = await registry.execute(name, input);

      if (!execResult.success) {
        if (options.throwOnError) {
          throw new Error(
            execResult.llmFeedback ??
              execResult.error?.message ??
              `Tool "${name}" failed with code ${execResult.code}`,
          );
        }
        return execResult;
      }

      return options.unwrapData ? execResult.data : execResult;
    };

    tools.push({
      name,
      description: tool.description,
      schema: tool.inputSchema,
      invoke: runGuarded,
      call: runGuarded,
      func: async (input: unknown): Promise<string> => {
        const execResult = await registry.execute(name, input);
        if (!execResult.success) {
          if (options.throwOnError) {
            throw new Error(
              execResult.llmFeedback ??
                execResult.error?.message ??
                `Tool "${name}" failed with code ${execResult.code}`,
            );
          }
          return JSON.stringify({
            success: false,
            code: execResult.code,
            llmFeedback: execResult.llmFeedback,
          });
        }
        return JSON.stringify(
          options.unwrapData ? execResult.data : execResult,
        );
      },
    });
  }

  return tools;
}
