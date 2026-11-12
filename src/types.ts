import type { z } from 'zod';
import type { BiometricAuthOptions } from './biometrics';

/**
 * Execution policy for a registered agent tool.
 * - `'auto'`: Execute immediately after input validation passes.
 * - `'confirm'`: Gate execution behind `onApprovalRequired` (e.g. a React Native modal sheet).
 * - `'biometric'`: Gate execution behind `onBiometricRequired` (e.g. FaceID / TouchID / Biometrics).
 * - `'deny'`: Block execution unconditionally.
 */
export type ToolPolicy = 'auto' | 'confirm' | 'biometric' | 'deny';

/**
 * Static policy string or dynamic policy function evaluated against the validated input.
 */
export type PolicyResolver<TInput = unknown> =
  | ToolPolicy
  | ((parsedInput: TInput) => ToolPolicy | Promise<ToolPolicy>);

/**
 * Configuration for registering a tool in the registry.
 */
export interface ToolDefinition<
  TSchema extends z.ZodType = z.ZodType,
  TOutput = unknown,
> {
  /** Human and LLM readable description of what the tool does. */
  description: string;
  /** Zod v4 schema used to validate and parse incoming tool arguments. */
  inputSchema: TSchema;
  /** Static policy or dynamic policy function based on parsed input. Defaults to registry's `defaultPolicy` ('auto'). */
  policy?: PolicyResolver<z.infer<TSchema>>;
  /** Optional execution timeout in milliseconds. Overrides registry's `defaultTimeoutMs`. */
  timeoutMs?: number;
  /** Tool execution handler invoked only after validation and policy checks succeed. */
  handler: (parsedInput: z.infer<TSchema>) => TOutput | Promise<TOutput>;
}

/**
 * Payload passed to `onApprovalRequired`, `onBiometricRequired`, and `<AgentApprovalProvider/>`.
 */
export interface ApprovalRequest<TInput = unknown> {
  /** Unique identifier for this approval request. */
  id: string;
  /** Name of the tool requesting execution. */
  toolName: string;
  /** Description of the tool. */
  description: string;
  /** Validated and parsed arguments passed to the tool. */
  input: TInput;
  /** The resolved policy that triggered this gate ('confirm' or 'biometric'). */
  policy: 'confirm' | 'biometric';
  /** Unix epoch timestamp (ms) when the request was created. */
  timestamp: number;
}

/**
 * Callback invoked when a tool resolves to the `'confirm'` policy.
 * Return `true` to allow execution, or `false` to deny.
 */
export type ApprovalHandler = (
  request: ApprovalRequest,
) => boolean | Promise<boolean>;

/**
 * Callback invoked when a tool resolves to the `'biometric'` policy.
 * Plug in `expo-local-authentication` or `react-native-biometrics` here.
 * Return `true` when biometric authentication succeeds, or `false` otherwise.
 */
export type BiometricHandler = (
  request: ApprovalRequest,
) => boolean | Promise<boolean>;

/**
 * Standardized error codes returned by `registry.execute()`.
 */
export type ToolExecutionErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'DENIED_BY_POLICY'
  | 'USER_DENIED'
  | 'BIOMETRIC_FAILED'
  | 'TIMEOUT_ERROR'
  | 'EXECUTION_ERROR';

/**
 * Status recorded for each execution in the audit log.
 */
export type AuditExecutionStatus = 'SUCCESS' | ToolExecutionErrorCode;

/**
 * Structured error details returned when a tool execution does not succeed.
 */
export interface ToolExecutionError {
  code: ToolExecutionErrorCode;
  message: string;
  issues?: unknown[];
}

/**
 * Structured result returned by `registry.execute(toolName, rawInput)`.
 * Never throws unhandled exceptions so agent loops can safely inspect results and self-correct.
 */
export interface ToolExecutionResult<TOutput = unknown> {
  /** Whether the tool executed to completion without validation, policy, timeout, or runtime errors. */
  success: boolean;
  /** Name of the tool that was invoked. */
  toolName: string;
  /** Output returned by the tool's `handler` when `success === true`. */
  data?: TOutput;
  /** Top-level error code when `success === false`. */
  code?: ToolExecutionErrorCode;
  /** Detailed error object when `success === false`. */
  error?: ToolExecutionError;
  /** Actionable feedback string formatted for LLM self-correction when `success === false`. */
  llmFeedback?: string;
  /** Resolved policy for the execution ('auto' | 'confirm' | 'biometric' | 'deny'). */
  policy?: ToolPolicy;
  /** Total wall-clock execution duration in milliseconds (including validation and approval wait). */
  durationMs: number;
}

/**
 * Entry recorded in the in-memory and optional persistent audit log.
 */
export interface AuditLogEntry {
  /** Unique audit entry ID. */
  id: string;
  /** Unix epoch timestamp (ms) when execution started. */
  timestamp: number;
  /** Name of the invoked tool. */
  toolName: string;
  /** Raw input before JSON parsing / Zod validation. */
  rawInput: unknown;
  /** Parsed input after Zod validation (if validation succeeded). */
  parsedInput?: unknown;
  /** Policy evaluated for this execution (if validation succeeded). */
  policy?: ToolPolicy;
  /** Final execution status. */
  status: AuditExecutionStatus;
  /** Total duration in milliseconds. */
  durationMs: number;
  /** Output returned by handler on success. */
  output?: unknown;
  /** Error message on failure. */
  errorMessage?: string;
}

/**
 * Storage adapter interface compatible with AsyncStorage and MMKV wrappers.
 */
export interface AuditStorageAdapter {
  getItem: (
    key: string,
  ) => string | null | undefined | Promise<string | null | undefined>;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem?: (key: string) => void | Promise<void>;
}

/**
 * Configuration options passed to `createToolRegistry(options)`.
 */
export interface ToolRegistryOptions {
  /** Fallback policy when a tool does not specify one. Defaults to `'auto'`. */
  defaultPolicy?: ToolPolicy;
  /** Default execution timeout in milliseconds if not specified per tool. Defaults to `30000` (30s). */
  defaultTimeoutMs?: number;
  /** Handler invoked when a tool requires `'confirm'` approval. */
  onApprovalRequired?: ApprovalHandler;
  /** Handler invoked when a tool requires `'biometric'` authentication. Defaults to `expo-local-authentication` when omitted. */
  onBiometricRequired?: BiometricHandler;
  /** Optional configuration for native `expo-local-authentication` prompts when `policy: 'biometric'` is triggered. */
  biometricOptions?: BiometricAuthOptions;
  /** Optional persistent storage adapter (e.g. AsyncStorage or MMKV) for audit logs. */
  auditStorage?: AuditStorageAdapter;
  /** Storage key used when persisting audit logs. Defaults to `'@react-native-agent-guard/audit-log'`. */
  auditStorageKey?: string;
  /** Maximum number of audit entries retained in memory and storage. Defaults to `500`. */
  maxAuditEntries?: number;
}

/**
 * OpenAI function-calling tool schema format.
 */
export interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * Anthropic Claude tool-use schema format.
 */
export interface ClaudeToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/**
 * Model Context Protocol (MCP) tool schema format.
 */
export interface MCPToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
