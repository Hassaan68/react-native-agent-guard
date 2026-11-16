import { z } from 'zod';
import {
  toLangChainTools,
  toVercelAITools,
  type LangChainAdapterOptions,
  type LangChainToolDefinition,
  type VercelAIAdapterOptions,
  type VercelAIToolDefinition,
} from './adapters';
import { authenticateWithExpoBiometrics } from './biometrics';
import {
  canonicalizeEnvelope,
  computePayloadHash,
  deepFreeze,
  GuardrailCanonicalizationError,
  GuardrailTamperError,
  normalizeValue,
} from './canonical';
import {
  MCPSSETransportAdapter,
  type MCPSSETransportOptions,
  type MCPToolDescriptor,
} from './mcp';
import { redactPIIValue } from './redaction';
import {
  zodToClaudeSchema,
  zodToMCPSchema,
  zodToOpenAISchema,
  type SchemaExportOptions,
} from './schemaExporters';
import type {
  ApprovalHandler,
  ApprovalRequest,
  AuditExecutionStatus,
  AuditLogEntry,
  AuditOutcome,
  AuditTelemetryCallback,
  AuditTelemetryEvent,
  BiometricAuthRequest,
  BiometricHandler,
  ClaudeToolSchema,
  MCPToolSchema,
  OpenAIToolSchema,
  RateLimitConfig,
  RateLimitExceededAction,
  ToolDefinition,
  ToolExecutionContext,
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
  private readonly auditListeners = new Set<AuditTelemetryCallback>();
  private readonly toolCallTimestamps = new Map<string, number[]>();
  private readonly toolSessionCounts = new Map<string, number>();
  private providerApprovalHandler?: ApprovalHandler;
  private providerBiometricHandler?: BiometricHandler;

  constructor(options: ToolRegistryOptions = {}) {
    this.options = options;
  }

  /**
   * Reset rate-limit and session counters for a specific tool, or for all tools if `toolName` is omitted.
   */
  public resetRateLimits(toolName?: string): void {
    if (toolName) {
      this.toolCallTimestamps.delete(toolName);
      this.toolSessionCounts.delete(toolName);
      return;
    }
    this.toolCallTimestamps.clear();
    this.toolSessionCounts.clear();
  }

  /**
   * Subscribe a telemetry listener that receives an `AuditTelemetryEvent`
   * after every approved, denied, or failed tool execution.
   * Returns an unsubscribe function.
   */
  public onAudit(listener: AuditTelemetryCallback): () => void {
    this.auditListeners.add(listener);
    return () => {
      this.auditListeners.delete(listener);
    };
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

    const parsedInput = deepFreeze(parseResult.data);
    const initialSchemaVersion = tool.schemaVersion ?? '1';

    let canonicalArgs: unknown;
    let expectedHash: string;
    try {
      canonicalArgs = normalizeValue(parsedInput);
      const envelope = canonicalizeEnvelope({
        toolName,
        schemaVersion: initialSchemaVersion,
        args: parsedInput,
      });
      expectedHash = computePayloadHash(envelope);
    } catch (err) {
      if (err instanceof GuardrailCanonicalizationError) {
        const errMsg = err.message;
        return this.finalizeFailure<TOutput>({
          startTime,
          toolName,
          rawInput,
          parsedInput,
          code: 'VALIDATION_ERROR',
          message: `Canonicalization failed for tool "${toolName}": ${errMsg}`,
          llmFeedback: `Tool "${toolName}" arguments could not be canonicalized: ${errMsg}.`,
        });
      }
      throw err;
    }

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
        canonicalArgs,
        payloadHash: expectedHash,
        schemaVersion: initialSchemaVersion,
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
        canonicalArgs,
        payloadHash: expectedHash,
        schemaVersion: initialSchemaVersion,
        policy: resolvedPolicy,
        code: 'DENIED_BY_POLICY',
        message,
        llmFeedback: `${message} Do not retry with the same restricted parameters.`,
      });
    }

    // 3b. Evaluate agent loop protection & rate limits (per-tool overrides global)
    const rateLimitCheck = this.evaluateRateLimit(toolName, tool.rateLimit);
    if (rateLimitCheck.exceeded) {
      const action: RateLimitExceededAction =
        rateLimitCheck.onLimitExceeded ?? 'deny';
      if (action === 'deny') {
        const message = rateLimitCheck.reason;
        return this.finalizeFailure<TOutput>({
          startTime,
          toolName,
          rawInput,
          parsedInput,
          canonicalArgs,
          payloadHash: expectedHash,
          schemaVersion: initialSchemaVersion,
          policy: resolvedPolicy,
          code: 'RATE_LIMITED',
          message,
          llmFeedback: `${message} Stop retrying tool "${toolName}" in a loop and inform the user or proceed with an alternative step.`,
        });
      }
      // Escalate policy to 'confirm' or 'biometric' when onLimitExceeded is set accordingly
      resolvedPolicy = action;
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
          canonicalArgs,
          payloadHash: expectedHash,
          schemaVersion: initialSchemaVersion,
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
        args: parsedInput,
        canonicalArgs,
        payloadHash: expectedHash,
        schemaVersion: initialSchemaVersion,
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
          canonicalArgs,
          payloadHash: expectedHash,
          schemaVersion: initialSchemaVersion,
          policy: resolvedPolicy,
          code: 'USER_DENIED',
          message,
          llmFeedback: `The user declined to approve tool "${toolName}". Respect the user's decision and do not immediately re-invoke this tool without asking.`,
        });
      }
    }

    let biometricAssertion: string | Record<string, unknown> | undefined;

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
        args: parsedInput,
        canonicalArgs,
        payloadHash: expectedHash,
        schemaVersion: initialSchemaVersion,
        policy: 'biometric',
        timestamp: Date.now(),
      };

      const biometricMeta: BiometricAuthRequest = {
        toolName,
        args: parsedInput,
        canonicalArgs,
        payloadHash: expectedHash,
        schemaVersion: initialSchemaVersion,
        request,
      };

      let verified = false;
      try {
        const rawBioResult =
          !this.providerBiometricHandler && this.options.onBiometricAuth
            ? await this.options.onBiometricAuth(
                toolName,
                parsedInput,
                biometricMeta,
              )
            : await biometricHandler(request, parsedInput, biometricMeta);

        if (typeof rawBioResult === 'boolean') {
          verified = rawBioResult;
        } else if (
          typeof rawBioResult === 'object' &&
          rawBioResult !== null &&
          'verified' in rawBioResult
        ) {
          verified = Boolean(rawBioResult.verified);
          if (verified && rawBioResult.biometricAssertion !== undefined) {
            biometricAssertion = rawBioResult.biometricAssertion;
          }
        }
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
          canonicalArgs,
          payloadHash: expectedHash,
          schemaVersion: initialSchemaVersion,
          policy: resolvedPolicy,
          code: 'BIOMETRIC_FAILED',
          message,
          llmFeedback: `Biometric authentication for tool "${toolName}" failed or was cancelled by the user. Do not retry automatically.`,
        });
      }
    }

    // 4. Pre-Handler TOCTOU Digest Re-Verification
    const currentSchemaVersion = tool.schemaVersion ?? '1';
    const recomputedHash = computePayloadHash(
      canonicalizeEnvelope({
        toolName,
        schemaVersion: currentSchemaVersion,
        args: parsedInput,
      }),
    );

    if (recomputedHash !== expectedHash) {
      const tamperError = new GuardrailTamperError(
        'TOCTOU integrity check failed: tool arguments or schema version drifted before handler execution',
        { expectedHash, actualHash: recomputedHash },
      );
      const durationMs = Math.max(0, Date.now() - startTime);
      await this.recordAudit({
        id: generateId('audit'),
        timestamp: startTime,
        toolName,
        rawInput,
        parsedInput,
        canonicalArgs,
        payloadHash: expectedHash,
        schemaVersion: currentSchemaVersion,
        policy: resolvedPolicy,
        status: 'TAMPER_DETECTED',
        durationMs,
        errorMessage: tamperError.message,
      });
      throw tamperError;
    }

    // 5. Execute handler with race-condition-free timeout enforcement
    const timeoutMs =
      tool.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const shouldRedactHandlerInput =
      typeof this.options.redactPII === 'object' &&
      this.options.redactPII !== null &&
      this.options.redactPII.redactHandlerInput === true;

    const handlerInput = shouldRedactHandlerInput
      ? redactPIIValue(parsedInput, this.options.redactPII)
      : parsedInput;

    const executionContext: ToolExecutionContext = {
      toolName,
      schemaVersion: currentSchemaVersion,
      payloadHash: expectedHash,
      canonicalArgs,
      policy: resolvedPolicy,
      ...(biometricAssertion !== undefined ? { biometricAssertion } : {}),
    };

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutSymbol = Symbol('TIMEOUT');

    try {
      const executionPromise = Promise.resolve().then(() =>
        tool.handler(handlerInput, executionContext),
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
          canonicalArgs,
          payloadHash: expectedHash,
          schemaVersion: currentSchemaVersion,
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
        canonicalArgs,
        payloadHash: expectedHash,
        schemaVersion: currentSchemaVersion,
        ...(biometricAssertion !== undefined ? { biometricAssertion } : {}),
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
        payloadHash: expectedHash,
        ...(biometricAssertion !== undefined ? { biometricAssertion } : {}),
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
        canonicalArgs,
        payloadHash: expectedHash,
        schemaVersion: currentSchemaVersion,
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
   * Export all registered tools in OpenAI function-calling schema format.
   * Safely handles `.transform()` and `.refine()` schemas and supports `{ strict: true }`.
   */
  public toOpenAITools(options: SchemaExportOptions = {}): OpenAIToolSchema[] {
    return Array.from(this.tools.entries()).map(([name, tool]) =>
      zodToOpenAISchema(name, tool.description, tool.inputSchema, options),
    );
  }

  /**
   * Export all registered tools in Anthropic Claude `input_schema` format.
   * Safely handles `.transform()` and `.refine()` schemas and supports `{ strict: true }`.
   */
  public toClaudeTools(options: SchemaExportOptions = {}): ClaudeToolSchema[] {
    return Array.from(this.tools.entries()).map(([name, tool]) =>
      zodToClaudeSchema(name, tool.description, tool.inputSchema, options),
    );
  }

  /**
   * Export all registered tools in Model Context Protocol (MCP) `inputSchema` format.
   * Safely handles `.transform()` and `.refine()` schemas.
   */
  public toMCPTools(options: SchemaExportOptions = {}): MCPToolSchema[] {
    return Array.from(this.tools.entries()).map(([name, tool]) =>
      zodToMCPSchema(name, tool.description, tool.inputSchema, options),
    );
  }

  /**
   * Convert all registered tools into a Vercel AI SDK (`generateText`, `streamText`, `useChat`)
   * compatible `tools` map whose `.execute()` calls automatically route through this registry's
   * guardrail policies, biometric authentication, and `<AgentApprovalSheet />`.
   */
  public toVercelAITools(
    options: VercelAIAdapterOptions = {},
  ): Record<string, VercelAIToolDefinition> {
    return toVercelAITools(this, options);
  }

  /**
   * Convert all registered tools into LangChain.js (`DynamicStructuredTool`, `ToolNode`, `bindTools`)
   * compatible tool objects whose `.invoke()`, `.call()`, and `.func()` methods automatically route
   * through this registry's guardrail policies, biometric authentication, and `<AgentApprovalSheet />`.
   */
  public toLangChainTools(
    options: LangChainAdapterOptions = {},
  ): LangChainToolDefinition[] {
    return toLangChainTools(this, options);
  }

  /**
   * Connect to a remote SSE-based Model Context Protocol (MCP) server,
   * automatically discover available tools via `tools/list`, convert their
   * JSON Schemas into Zod validators, and register them dynamically into this registry.
   */
  public async connectMCP(
    transportOrOptions: MCPSSETransportAdapter | MCPSSETransportOptions,
  ): Promise<{
    transport: MCPSSETransportAdapter;
    tools: MCPToolDescriptor[];
  }> {
    const transport =
      transportOrOptions instanceof MCPSSETransportAdapter
        ? transportOrOptions
        : new MCPSSETransportAdapter(transportOrOptions);

    const tools = await transport.registerTools(this);
    return { transport, tools };
  }

  private async finalizeFailure<TOutput>(params: {
    startTime: number;
    toolName: string;
    rawInput: unknown;
    parsedInput?: unknown;
    canonicalArgs?: unknown;
    payloadHash?: string;
    schemaVersion?: string;
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
      canonicalArgs: params.canonicalArgs,
      payloadHash: params.payloadHash,
      schemaVersion: params.schemaVersion,
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
      ...(params.payloadHash ? { payloadHash: params.payloadHash } : {}),
      durationMs,
    };
  }

  private evaluateRateLimit(
    toolName: string,
    toolRateLimit?: RateLimitConfig,
  ): {
    exceeded: boolean;
    reason: string;
    onLimitExceeded?: RateLimitExceededAction;
  } {
    const globalLimit = this.options.rateLimit;
    const effectiveConfig: RateLimitConfig | undefined =
      toolRateLimit || globalLimit
        ? {
            maxCallsPerMinute:
              toolRateLimit?.maxCallsPerMinute ??
              globalLimit?.maxCallsPerMinute,
            maxSessionCalls:
              toolRateLimit?.maxSessionCalls ?? globalLimit?.maxSessionCalls,
            onLimitExceeded:
              toolRateLimit?.onLimitExceeded ??
              globalLimit?.onLimitExceeded ??
              'deny',
          }
        : undefined;

    if (!effectiveConfig) {
      return { exceeded: false, reason: '' };
    }

    const now = Date.now();
    const windowStart = now - 60_000;

    const existingTimestamps = this.toolCallTimestamps.get(toolName) ?? [];
    const recentTimestamps = existingTimestamps.filter(
      (ts) => ts > windowStart,
    );
    recentTimestamps.push(now);
    this.toolCallTimestamps.set(toolName, recentTimestamps);

    const nextSessionCount = (this.toolSessionCounts.get(toolName) ?? 0) + 1;
    this.toolSessionCounts.set(toolName, nextSessionCount);

    if (
      effectiveConfig.maxSessionCalls !== undefined &&
      nextSessionCount > effectiveConfig.maxSessionCalls
    ) {
      return {
        exceeded: true,
        reason: `Rate limit exceeded for tool "${toolName}": session call quota (${effectiveConfig.maxSessionCalls}) reached.`,
        onLimitExceeded: effectiveConfig.onLimitExceeded,
      };
    }

    if (
      effectiveConfig.maxCallsPerMinute !== undefined &&
      recentTimestamps.length > effectiveConfig.maxCallsPerMinute
    ) {
      return {
        exceeded: true,
        reason: `Rate limit exceeded for tool "${toolName}": maximum call frequency (${effectiveConfig.maxCallsPerMinute} calls/min) exceeded.`,
        onLimitExceeded: effectiveConfig.onLimitExceeded,
      };
    }

    return { exceeded: false, reason: '' };
  }

  private resolveOutcome(status: AuditExecutionStatus): AuditOutcome {
    if (status === 'SUCCESS') {
      return 'approved';
    }
    if (
      status === 'DENIED_BY_POLICY' ||
      status === 'RATE_LIMITED' ||
      status === 'USER_DENIED' ||
      status === 'BIOMETRIC_FAILED'
    ) {
      return 'denied';
    }
    return 'failed';
  }

  private async recordAudit(entry: AuditLogEntry): Promise<void> {
    const piiOption = this.options.redactPII;
    const sanitizedEntry: AuditLogEntry = piiOption
      ? {
          ...entry,
          rawInput: redactPIIValue(entry.rawInput, piiOption),
          ...(entry.parsedInput !== undefined
            ? { parsedInput: redactPIIValue(entry.parsedInput, piiOption) }
            : {}),
          ...(entry.canonicalArgs !== undefined
            ? { canonicalArgs: redactPIIValue(entry.canonicalArgs, piiOption) }
            : {}),
          ...(entry.output !== undefined
            ? { output: redactPIIValue(entry.output, piiOption) }
            : {}),
        }
      : entry;

    const maxEntries =
      this.options.maxAuditEntries ?? DEFAULT_MAX_AUDIT_ENTRIES;
    this.auditLog.push(sanitizedEntry);
    if (this.auditLog.length > maxEntries) {
      this.auditLog.splice(0, this.auditLog.length - maxEntries);
    }

    const telemetryEvent: AuditTelemetryEvent = {
      ...sanitizedEntry,
      isoTimestamp: new Date(sanitizedEntry.timestamp).toISOString(),
      arguments:
        sanitizedEntry.parsedInput !== undefined
          ? sanitizedEntry.parsedInput
          : sanitizedEntry.rawInput,
      outcome: this.resolveOutcome(sanitizedEntry.status),
      duration: sanitizedEntry.durationMs,
    };

    const callbacks: AuditTelemetryCallback[] = [];
    if (this.options.onAudit) {
      callbacks.push(this.options.onAudit);
    }
    if (this.options.onExecution) {
      callbacks.push(this.options.onExecution);
    }
    for (const listener of this.auditListeners) {
      callbacks.push(listener);
    }

    for (const cb of callbacks) {
      try {
        await cb(telemetryEvent);
      } catch {
        // Never allow telemetry callback errors to interrupt tool execution
      }
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
      persisted.push(sanitizedEntry);
      if (persisted.length > maxEntries) {
        persisted = persisted.slice(persisted.length - maxEntries);
      }
      await storage.setItem(
        key,
        JSON.stringify(persisted, (_k, v) =>
          typeof v === 'bigint' ? `${v.toString()}n` : v,
        ),
      );
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
