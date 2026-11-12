import { z } from 'zod';
import { authenticateWithExpoBiometrics } from './biometrics';
import type {
  ApprovalHandler,
  ApprovalRequest,
  AuditExecutionStatus,
  AuditLogEntry,
  BiometricHandler,
  ClaudeToolSchema,
  MCPToolSchema,
  OpenAIToolSchema,
  ToolDefinition,
  ToolExecutionErrorCode,
  ToolExecutionResult,
  ToolPolicy,
  ToolRegistryOptions,
} from './types';

const DEFAULT_AUDIT_STORAGE_KEY = '@react-native-agent-guard/audit-log';
const DEFAULT_MAX_AUDIT_ENTRIES = 500;
const DEFAULT_TIMEOUT_MS = 30_000;

let idCounter = 0;
function generateId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${Date.now()}_${idCounter}`;
}

function formatZodIssuesForLLM(
  toolName: string,
  issues: z.core.$ZodIssue[],
  jsonParseError?: string,
): string {
  const details = issues
    .map((issue) => {
      const pathStr =
        issue.path && issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `- "${pathStr}": ${issue.message}`;
    })
    .join('\n');

  const jsonHint = jsonParseError
    ? `\nNote: Raw input was a string that failed JSON.parse (${jsonParseError}). Ensure arguments are valid JSON matching the schema.`
    : '';

  return `Validation failed for tool "${toolName}". Please correct the following input arguments and retry:\n${details}${jsonHint}`;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<z.ZodType, unknown>>();
  private readonly options: ToolRegistryOptions;
  private readonly auditLog: AuditLogEntry[] = [];
  private providerApprovalHandler?: ApprovalHandler;
  private providerBiometricHandler?: BiometricHandler;

  constructor(options: ToolRegistryOptions = {}) {
    this.options = options;
  }

  /**
   * Register a tool with a Zod input schema, execution policy, optional timeout, and handler.
   */
  public register<TSchema extends z.ZodType, TOutput = unknown>(
    name: string,
    definition: ToolDefinition<TSchema, TOutput>,
  ): this {
    if (!name || typeof name !== 'string') {
      throw new Error('Tool name must be a non-empty string.');
    }
    this.tools.set(
      name,
      definition as unknown as ToolDefinition<z.ZodType, unknown>,
    );
    return this;
  }

  /**
   * Remove a registered tool by name.
   */
  public unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Retrieve a registered tool definition by name.
   */
  public getTool(
    name: string,
  ): ToolDefinition<z.ZodType, unknown> | undefined {
    return this.tools.get(name);
  }

  /**
   * List all registered tool names.
   */
  public getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * Internal hook used by `<AgentApprovalProvider>` to bind its FIFO approval queue.
   */
  public setApprovalHandler(handler: ApprovalHandler | undefined): void {
    this.providerApprovalHandler = handler;
  }

  /**
   * Optional hook to dynamically update the biometric handler at runtime.
   */
  public setBiometricHandler(handler: BiometricHandler | undefined): void {
    this.providerBiometricHandler = handler;
  }

  /**
   * Return a shallow copy of the in-memory execution audit log.
   */
  public getAuditLog(): AuditLogEntry[] {
    return [...this.auditLog];
  }

  /**
   * Clear the in-memory and persistent audit logs.
   */
  public async clearAuditLog(): Promise<void> {
    this.auditLog.length = 0;
    const storage = this.options.auditStorage;
    if (storage) {
      const key = this.options.auditStorageKey ?? DEFAULT_AUDIT_STORAGE_KEY;
      if (storage.removeItem) {
        await storage.removeItem(key);
      } else {
        await storage.setItem(key, JSON.stringify([]));
      }
    }
  }

  /**
   * Execute a registered tool with safe JSON parsing, async Zod validation,
   * static/dynamic policy enforcement, timeout protection, and audit logging.
   * Never throws unhandled exceptions.
   */
  public async execute<TOutput = unknown>(
    toolName: string,
    rawInput: unknown,
  ): Promise<ToolExecutionResult<TOutput>> {
    const startTime = Date.now();
    const tool = this.tools.get(toolName);

    if (!tool) {
      const message = `Tool "${toolName}" is not registered. Available tools: ${
        this.getToolNames().join(', ') || 'none'
      }.`;
      return this.finalizeFailure<TOutput>({
        startTime,
        toolName,
        rawInput,
        code: 'TOOL_NOT_FOUND',
        message,
        llmFeedback: message,
      });
    }

    // 1. Safely parse stringified JSON if an LLM passes a JSON string
    let candidateInput: unknown = rawInput;
    let jsonParseError: string | undefined;

    if (typeof rawInput === 'string') {
      const trimmed = rawInput.trim();
      try {
        candidateInput = JSON.parse(trimmed);
      } catch (err) {
        jsonParseError =
          err instanceof Error ? err.message : 'Invalid JSON string';
        candidateInput = rawInput;
      }
    }

    // 2. Validate inputs via inputSchema.safeParseAsync()
    let parseResult: z.ZodSafeParseResult<unknown>;
    try {
      parseResult = await tool.inputSchema.safeParseAsync(candidateInput);
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Schema validation exception';
      return this.finalizeFailure<TOutput>({
        startTime,
        toolName,
        rawInput,
        code: 'VALIDATION_ERROR',
        message: `Input validation failed for tool "${toolName}": ${errMsg}`,
        llmFeedback: `Validation failed for tool "${toolName}": ${errMsg}. Please fix the arguments and retry.`,
      });
    }

    if (!parseResult.success) {
      const issues = parseResult.error.issues;
      const llmFeedback = formatZodIssuesForLLM(
        toolName,
        issues,
        jsonParseError,
      );
      const message = `Invalid arguments for tool "${toolName}": ${issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')}`;

      return this.finalizeFailure<TOutput>({
        startTime,
        toolName,
        rawInput,
        code: 'VALIDATION_ERROR',
        message,
        issues,
        llmFeedback,
      });
    }

    const parsedInput = parseResult.data;

    // 3. Evaluate static or dynamic policy
    let resolvedPolicy: ToolPolicy;
    try {
      const policyResolver =
        tool.policy ?? this.options.defaultPolicy ?? 'auto';
      resolvedPolicy =
        typeof policyResolver === 'function'
          ? await policyResolver(parsedInput)
          : policyResolver;
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : 'Policy evaluation failed';
      return this.finalizeFailure<TOutput>({
        startTime,
        toolName,
        rawInput,
        parsedInput,
        code: 'DENIED_BY_POLICY',
        message: `Policy evaluation failed for tool "${toolName}": ${errMsg}`,
        llmFeedback: `Tool "${toolName}" could not be executed because policy evaluation failed: ${errMsg}.`,
      });
    }

    if (resolvedPolicy === 'deny') {
      const message = `Execution of tool "${toolName}" is denied by security policy.`;
      return this.finalizeFailure<TOutput>({
        startTime,
        toolName,
        rawInput,
        parsedInput,
        policy: resolvedPolicy,
        code: 'DENIED_BY_POLICY',
        message,
        llmFeedback: `${message} Do not retry with the same restricted parameters.`,
      });
    }

    if (resolvedPolicy === 'confirm') {
      const approvalHandler =
        this.providerApprovalHandler ?? this.options.onApprovalRequired;

      if (!approvalHandler) {
        const message = `Tool "${toolName}" requires user confirmation ('confirm' policy), but no onApprovalRequired handler or <AgentApprovalProvider> is configured.`;
        return this.finalizeFailure<TOutput>({
          startTime,
          toolName,
          rawInput,
          parsedInput,
          policy: resolvedPolicy,
          code: 'USER_DENIED',
          message,
          llmFeedback: `Tool "${toolName}" requires user approval, which could not be obtained.`,
        });
      }

      const request: ApprovalRequest = {
        id: generateId('approval'),
        toolName,
        description: tool.description,
        input: parsedInput,
        policy: 'confirm',
        timestamp: Date.now(),
      };

      let approved = false;
      try {
        approved = await approvalHandler(request);
      } catch {
        approved = false;
      }

      if (!approved) {
        const message = `User denied execution of tool "${toolName}".`;
        return this.finalizeFailure<TOutput>({
          startTime,
          toolName,
          rawInput,
          parsedInput,
          policy: resolvedPolicy,
          code: 'USER_DENIED',
          message,
          llmFeedback: `The user declined to approve tool "${toolName}". Respect the user's decision and do not immediately re-invoke this tool without asking.`,
        });
      }
    }

    if (resolvedPolicy === 'biometric') {
      const biometricHandler =
        this.providerBiometricHandler ??
        this.options.onBiometricRequired ??
        ((req: ApprovalRequest) =>
          authenticateWithExpoBiometrics(req, this.options.biometricOptions));

      const request: ApprovalRequest = {
        id: generateId('biometric'),
        toolName,
        description: tool.description,
        input: parsedInput,
        policy: 'biometric',
        timestamp: Date.now(),
      };

      let verified = false;
      try {
        verified = await biometricHandler(request);
      } catch {
        verified = false;
      }

      if (!verified) {
        const message = `Biometric verification failed or was cancelled for tool "${toolName}".`;
        return this.finalizeFailure<TOutput>({
          startTime,
          toolName,
          rawInput,
          parsedInput,
          policy: resolvedPolicy,
          code: 'BIOMETRIC_FAILED',
          message,
          llmFeedback: `Biometric authentication for tool "${toolName}" failed or was cancelled by the user. Do not retry automatically.`,
        });
      }
    }

    // 4. Execute handler with race-condition-free timeout enforcement
    const timeoutMs =
      tool.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutSymbol = Symbol('TIMEOUT');

    try {
      const executionPromise = Promise.resolve().then(() =>
        tool.handler(parsedInput),
      );

      const raceResult =
        timeoutMs > 0
          ? await Promise.race([
              executionPromise,
              new Promise<typeof timeoutSymbol>((resolve) => {
                timeoutId = setTimeout(() => resolve(timeoutSymbol), timeoutMs);
              }),
            ])
          : await executionPromise;

      if (raceResult === timeoutSymbol) {
        // Prevent unhandled rejection if the underlying handler rejects later
        executionPromise.catch(() => {});
        const message = `Tool "${toolName}" timed out after ${timeoutMs}ms.`;
        return this.finalizeFailure<TOutput>({
          startTime,
          toolName,
          rawInput,
          parsedInput,
          policy: resolvedPolicy,
          code: 'TIMEOUT_ERROR',
          message,
          llmFeedback: `${message} Consider retrying later or informing the user that the operation took too long.`,
        });
      }

      const durationMs = Math.max(0, Date.now() - startTime);
      await this.recordAudit({
        id: generateId('audit'),
        timestamp: startTime,
        toolName,
        rawInput,
        parsedInput,
        policy: resolvedPolicy,
        status: 'SUCCESS',
        durationMs,
        output: raceResult,
      });

      return {
        success: true,
        toolName,
        data: raceResult as TOutput,
        policy: resolvedPolicy,
        durationMs,
      };
    } catch (err) {
      const errMsg =
        err instanceof Error ? err.message : String(err ?? 'Unknown error');
      const message = `Tool "${toolName}" failed during execution: ${errMsg}`;
      return this.finalizeFailure<TOutput>({
        startTime,
        toolName,
        rawInput,
        parsedInput,
        policy: resolvedPolicy,
        code: 'EXECUTION_ERROR',
        message,
        llmFeedback: `Tool "${toolName}" encountered an execution error: ${errMsg}.`,
      });
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Export all registered tools in OpenAI function-calling schema format
   * using Zod v4's `z.toJSONSchema(schema, { target: 'draft-07' })`.
   */
  public toOpenAITools(): OpenAIToolSchema[] {
    return Array.from(this.tools.entries()).map(([name, tool]) => ({
      type: 'function',
      function: {
        name,
        description: tool.description,
        parameters: z.toJSONSchema(tool.inputSchema, {
          target: 'draft-07',
        }) as Record<string, unknown>,
      },
    }));
  }

  /**
   * Export all registered tools in Anthropic Claude `input_schema` format
   * using Zod v4's `z.toJSONSchema(schema, { target: 'draft-07' })`.
   */
  public toClaudeTools(): ClaudeToolSchema[] {
    return Array.from(this.tools.entries()).map(([name, tool]) => ({
      name,
      description: tool.description,
      input_schema: z.toJSONSchema(tool.inputSchema, {
        target: 'draft-07',
      }) as Record<string, unknown>,
    }));
  }

  /**
   * Export all registered tools in Model Context Protocol (MCP) `inputSchema` format
   * using Zod v4's `z.toJSONSchema(schema, { target: 'draft-07' })`.
   */
  public toMCPTools(): MCPToolSchema[] {
    return Array.from(this.tools.entries()).map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.inputSchema, {
        target: 'draft-07',
      }) as Record<string, unknown>,
    }));
  }

  private async finalizeFailure<TOutput>(params: {
    startTime: number;
    toolName: string;
    rawInput: unknown;
    parsedInput?: unknown;
    policy?: ToolPolicy;
    code: ToolExecutionErrorCode;
    message: string;
    issues?: unknown[];
    llmFeedback: string;
  }): Promise<ToolExecutionResult<TOutput>> {
    const durationMs = Math.max(0, Date.now() - params.startTime);

    await this.recordAudit({
      id: generateId('audit'),
      timestamp: params.startTime,
      toolName: params.toolName,
      rawInput: params.rawInput,
      parsedInput: params.parsedInput,
      policy: params.policy,
      status: params.code as AuditExecutionStatus,
      durationMs,
      errorMessage: params.message,
    });

    return {
      success: false,
      toolName: params.toolName,
      code: params.code,
      error: {
        code: params.code,
        message: params.message,
        ...(params.issues ? { issues: params.issues } : {}),
      },
      llmFeedback: params.llmFeedback,
      ...(params.policy ? { policy: params.policy } : {}),
      durationMs,
    };
  }

  private async recordAudit(entry: AuditLogEntry): Promise<void> {
    const maxEntries =
      this.options.maxAuditEntries ?? DEFAULT_MAX_AUDIT_ENTRIES;
    this.auditLog.push(entry);
    if (this.auditLog.length > maxEntries) {
      this.auditLog.splice(0, this.auditLog.length - maxEntries);
    }

    const storage = this.options.auditStorage;
    if (!storage) {
      return;
    }

    const key = this.options.auditStorageKey ?? DEFAULT_AUDIT_STORAGE_KEY;
    try {
      const existingRaw = await storage.getItem(key);
      let persisted: AuditLogEntry[] = [];
      if (existingRaw && typeof existingRaw === 'string') {
        try {
          const parsed = JSON.parse(existingRaw);
          if (Array.isArray(parsed)) {
            persisted = parsed as AuditLogEntry[];
          }
        } catch {
          persisted = [];
        }
      }
      persisted.push(entry);
      if (persisted.length > maxEntries) {
        persisted = persisted.slice(persisted.length - maxEntries);
      }
      await storage.setItem(key, JSON.stringify(persisted));
    } catch {
      // Never allow storage adapter errors to crash tool execution
    }
  }
}

/**
 * Factory function to create a new `ToolRegistry` instance.
 */
export function createToolRegistry(
  options: ToolRegistryOptions = {},
): ToolRegistry {
  return new ToolRegistry(options);
}
