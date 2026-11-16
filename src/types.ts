import type { z } from 'zod';
import type { BiometricAuthOptions } from './biometrics';
import type {
  CanonicalizerCodec,
  CanonicalizerTestVector,
} from './canonical';
import type { PIIRedactionOption } from './redaction';
import type { ThreatDetection, ThreatScannerOption } from './threatScanner';

export type { CanonicalizerCodec, CanonicalizerTestVector };

/**
 * Single field-level before/after diff entry returned by a tool's `preview(args)` generator.
 */
export interface ToolPreviewDiffEntry {
  field: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Risk classification badge displayed in `<AgentApprovalSheet />` for dry-run previews.
 */
export type ToolPreviewRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/**
 * Dry-run impact preview or structured before/after diff returned by `ToolDefinition.preview(args)`.
 */
export type ToolPreviewResult =
  | string
  | {
      summary?: string;
      before?: Record<string, unknown> | unknown;
      after?: Record<string, unknown> | unknown;
      changes?: ToolPreviewDiffEntry[];
      riskLevel?: ToolPreviewRiskLevel;
    };

/**
 * Execution policy for a registered agent tool.
 * - `'auto'`: Execute immediately after input validation passes.
 * - `'confirm'`: Gate execution behind `onApprovalRequired` (e.g. a React Native modal sheet).
 * - `'biometric'`: Gate execution behind `onBiometricRequired` (e.g. FaceID / TouchID / Biometrics).
 * - `'deny'`: Block execution unconditionally.
 */
export type ToolPolicy = 'auto' | 'confirm' | 'biometric' | 'deny';

/**
 * Alias for `ToolPolicy`.
 */
export type GuardrailPolicy = ToolPolicy;

/**
 * Result returned by a biometric handler (`onBiometricAuth` / `onBiometricRequired`).
 * Can be a boolean (`true` = verified, `false` = denied) or a structured attestation object
 * carrying a cryptographic assertion (e.g. Secure Enclave / Android Keystore signature or WebAuthn token).
 */
export type BiometricAttestationResult =
  | boolean
  | {
      verified: boolean;
      biometricAssertion?: string | Record<string, unknown>;
      [key: string]: unknown;
    };

/**
 * Context metadata passed as the 3rd argument to `onBiometricAuth` / `onBiometricRequired`
 * and used for hardware-backed biometric attestation binding.
 */
export interface BiometricAuthRequest<TArgs = unknown> {
  /** Name of the tool requesting biometric authentication. */
  toolName: string;
  /** Validated and deep-frozen arguments passed to the tool. */
  args: Readonly<TArgs>;
  /** Deterministically normalized WYSIWYS arguments (RFC 8785 / JCS). */
  canonicalArgs: unknown;
  /** Lowercase hex SHA-256 digest of the canonical execution envelope. */
  payloadHash: string;
  /** Tool schema version string (defaults to `'1'`). */
  schemaVersion: string;
  /** Full `ApprovalRequest` metadata object. */
  request?: ApprovalRequest<TArgs>;
}

/**
 * Execution context passed as the 2nd argument to `ToolDefinition.handler(args, context)`.
 */
export interface ToolExecutionContext {
  /** Name of the invoked tool. */
  toolName: string;
  /** Schema version bound into the canonical envelope digest (defaults to `'1'`). */
  schemaVersion: string;
  /** Lowercase hex SHA-256 digest of the canonical execution envelope (`{ args, schemaVersion, toolName }`). */
  payloadHash: string;
  /** Deterministically normalized WYSIWYS arguments (RFC 8785 / JCS). */
  canonicalArgs: unknown;
  /** Resolved guardrail policy for this execution (`'auto' | 'confirm' | 'biometric' | 'deny'`). */
  policy: GuardrailPolicy;
  /** Optional hardware-backed biometric assertion returned by `onBiometricAuth` / `onBiometricRequired`. */
  biometricAssertion?: string | Record<string, unknown>;
  /** `true` if execution was auto-authorized by an active time-bound or session-scoped `SessionGrant`. */
  sessionGrantUsed?: boolean;
  /** Optional dry-run preview or before/after diff computed before approval. */
  previewResult?: ToolPreviewResult;
  /** Optional error message if `tool.preview(args)` threw during dry-run evaluation. */
  previewError?: string;
  /** Optional threat detections flagged when `threatScanner` ran with `blockOnThreat: false`. */
  threats?: ThreatDetection[];
}

/**
 * Quick-action option for time-bound or session-scoped user approval grants
 * (e.g., `{ label: 'Allow for 5 mins', durationMs: 300_000 }`).
 */
export interface SessionGrantOption {
  /** Human-readable button label displayed in `<AgentApprovalSheet />`. */
  label: string;
  /** Grant TTL in milliseconds, or `'session'` for the lifetime of the registry session. */
  durationMs: number | 'session';
  /** Whether this option may be used to grant temporary bypasses for `'biometric'` policies. Defaults to `false`. */
  allowBiometricDowngrade?: boolean;
  /** Optional cap on the number of calls permitted under this session grant. */
  maxCalls?: number;
}

/**
 * Active time-bound or session-scoped approval grant stored in `GuardrailRegistry`.
 */
export interface SessionGrant {
  /** Name of the tool covered by this grant. */
  toolName: string;
  /** Unix epoch timestamp (ms) when the grant was created. */
  grantedAt: number;
  /** Unix epoch timestamp (ms) when the grant expires, or `null` for `'session'` grants. */
  expiresAt: number | null;
  /** Optional remaining call quota before the grant is automatically revoked. */
  remainingCalls?: number;
  /** The policy tier covered by this grant (`'confirm'` or `'biometric'`). */
  policy: GuardrailPolicy;
}

/**
 * Resolution value returned by an `ApprovalHandler` or passed to `request.resolve(...)`.
 * Can be a simple boolean (`true` = approve once, `false` = deny) or an object specifying a `grantDurationMs` / `maxCalls` session grant.
 */
export type ApprovalResolution =
  | boolean
  | {
      approved: boolean;
      grantDurationMs?: number | 'session';
      maxCalls?: number;
    };

/**
 * Serializable representation of a pending approval request for offline/background persistence via `QueueStorageAdapter`.
 */
export interface SerializedQueuedRequest<TInput = unknown> {
  id: string;
  toolName: string;
  description: string;
  input: TInput;
  canonicalArgs?: unknown;
  payloadHash?: string;
  schemaVersion?: string;
  policy: 'confirm' | 'biometric';
  createdAt: number;
  timestamp: number;
  expiresAt?: number;
}

/**
 * Storage adapter interface for persisting and rehydrating pending approval requests across app backgrounding/restarts.
 */
export interface QueueStorageAdapter {
  loadQueue: () =>
    | Promise<SerializedQueuedRequest[]>
    | SerializedQueuedRequest[];
  saveQueue: (items: SerializedQueuedRequest[]) => Promise<void> | void;
}

/**
 * Static policy string or dynamic policy function evaluated against the validated input.
 */
export type PolicyResolver<TInput = unknown> =
  | ToolPolicy
  | ((parsedInput: TInput) => ToolPolicy | Promise<ToolPolicy>);

/**
 * Action taken when a tool exceeds its configured `rateLimit` (`maxCallsPerMinute` or `maxSessionCalls`).
 * - `'deny'`: Block execution immediately with `code: 'RATE_LIMITED'` and self-correction `llmFeedback`.
 * - `'confirm'`: Escalate the execution policy to require explicit user modal approval (`<AgentApprovalSheet />`).
 * - `'biometric'`: Escalate the execution policy to require hardware biometric authentication (`FaceID` / `TouchID`).
 */
export type RateLimitExceededAction = 'deny' | 'confirm' | 'biometric';

/**
 * Agent loop protection and rate-limiting configuration at the global registry or per-tool level.
 */
export interface RateLimitConfig {
  /** Maximum number of calls allowed within a rolling 60-second window. */
  maxCallsPerMinute?: number;
  /** Maximum total number of calls allowed during the current registry session. */
  maxSessionCalls?: number;
  /**
   * Behavior when `maxCallsPerMinute` or `maxSessionCalls` is exceeded.
   * Defaults to `'deny'` (returns `RATE_LIMITED`). Set to `'confirm'` or `'biometric'` to escalate policy instead.
   */
  onLimitExceeded?: RateLimitExceededAction;
}

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
  /** Optional schema version string bound into the canonical SHA-256 digest. Defaults to `'1'`. */
  schemaVersion?: string;
  /** Static policy or dynamic policy function based on parsed input. Defaults to registry's `defaultPolicy` ('auto'). */
  policy?: PolicyResolver<z.infer<TSchema>>;
  /** Optional execution timeout in milliseconds. Overrides registry's `defaultTimeoutMs`. */
  timeoutMs?: number;
  /** Optional approval expiration TTL in milliseconds when waiting in the confirmation queue. Overrides registry's `approvalTimeoutMs`. */
  approvalTimeoutMs?: number;
  /** Optional per-tool rate limit and loop protection configuration. Overrides global `rateLimit`. */
  rateLimit?: RateLimitConfig;
  /** Optional time-bound session grant presets offered in `<AgentApprovalSheet />` for this tool. */
  sessionGrantOptions?: SessionGrantOption[];
  /** Whether active session grants may bypass `'biometric'` prompts for this tool. Defaults to `false`. */
  allowBiometricSessionGrants?: boolean;
  /** Optional dry-run / impact preview generator evaluated before presenting `<AgentApprovalSheet />`. */
  preview?: (
    parsedInput: z.infer<TSchema>,
  ) => Promise<ToolPreviewResult> | ToolPreviewResult;
  /** Optional per-tool input threat scanner configuration (overrides global `threatScanner`). */
  threatScanner?: ThreatScannerOption;
  /** Tool execution handler invoked only after validation, policy checks, and TOCTOU digest verification succeed. */
  handler: (
    parsedInput: z.infer<TSchema>,
    context: ToolExecutionContext,
  ) => TOutput | Promise<TOutput>;
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
  /** Alias for `input` (validated and deep-frozen arguments). */
  args?: Readonly<TInput>;
  /** Deterministically normalized WYSIWYS arguments (RFC 8785 / JCS). */
  canonicalArgs?: unknown;
  /** Lowercase hex SHA-256 digest of the canonical execution envelope. */
  payloadHash?: string;
  /** Schema version bound into `payloadHash` (defaults to `'1'`). */
  schemaVersion?: string;
  /** The resolved policy that triggered this gate ('confirm' or 'biometric'). */
  policy: 'confirm' | 'biometric';
  /** Unix epoch timestamp (ms) when the request was created. */
  timestamp: number;
  /** Unix epoch timestamp (ms) when the request was created (alias for `timestamp`). */
  createdAt?: number;
  /** Optional Unix epoch timestamp (ms) when this approval request expires (`createdAt + approvalTimeoutMs`). */
  expiresAt?: number;
  /** Optional time-bound session grant presets available for this request. */
  sessionGrantOptions?: SessionGrantOption[];
  /** Optional dry-run impact preview or before/after diff computed by `tool.preview(args)`. */
  previewResult?: ToolPreviewResult;
  /** Optional error message if `tool.preview(args)` failed during dry-run evaluation. */
  previewError?: string;
  /** Optional threat detections attached when `threatScanner` runs with `blockOnThreat: false`. */
  threats?: ThreatDetection[];
  /** Optional direct resolution callback supporting `boolean` or `{ approved, grantDurationMs, maxCalls }`. */
  resolve?: (resolution: ApprovalResolution) => void;
}

/**
 * Callback invoked when a tool resolves to the `'confirm'` policy.
 * Return `true` / `{ approved: true, grantDurationMs?: ... }` to allow execution, or `false` to deny.
 */
export type ApprovalHandler = (
  request: ApprovalRequest,
) => ApprovalResolution | Promise<ApprovalResolution>;

/**
 * Callback invoked when a tool resolves to the `'biometric'` policy.
 * Plug in `expo-local-authentication`, `react-native-biometrics`, or hardware key attestation here.
 * Return `true` or `{ verified: true, biometricAssertion?: ... }` when biometric authentication succeeds.
 */
export type BiometricHandler = (
  request: ApprovalRequest,
  args?: unknown,
  meta?: BiometricAuthRequest,
) => BiometricAttestationResult | Promise<BiometricAttestationResult>;

/**
 * Positional biometric authentication & hardware attestation callback (`onBiometricAuth`).
 * Receives `(toolName, args, meta)` where `meta` contains `{ payloadHash, schemaVersion, canonicalArgs, toolName, args }`.
 */
export type BiometricAuthHandler = (
  toolName: string,
  args: unknown,
  meta: BiometricAuthRequest,
) => BiometricAttestationResult | Promise<BiometricAttestationResult>;

/**
 * Standardized error codes returned by `registry.execute()`.
 */
export type ToolExecutionErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'DENIED_BY_POLICY'
  | 'RATE_LIMITED'
  | 'USER_DENIED'
  | 'BIOMETRIC_FAILED'
  | 'TAMPER_DETECTED'
  | 'THREAT_DETECTED'
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
  /** Lowercase hex SHA-256 digest of the canonical execution envelope (`{ args, schemaVersion, toolName }`). */
  payloadHash?: string;
  /** Optional hardware-backed biometric assertion returned by `onBiometricAuth` / `onBiometricRequired`. */
  biometricAssertion?: string | Record<string, unknown>;
  /** `true` if execution was authorized by an active time-bound or session-scoped `SessionGrant`. */
  sessionGrantUsed?: boolean;
  /** Total wall-clock execution duration in milliseconds (including validation and approval wait). */
  durationMs: number;
}

/**
 * High-level governance outcome category for telemetry and analytics.
 */
export type AuditOutcome = 'approved' | 'denied' | 'failed';

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
  /** Deterministically normalized WYSIWYS arguments (if validation succeeded). */
  canonicalArgs?: unknown;
  /** Lowercase hex SHA-256 digest of the canonical execution envelope (if validation succeeded). */
  payloadHash?: string;
  /** Schema version bound into `payloadHash`. */
  schemaVersion?: string;
  /** Canonicalizer algorithm version bound into `payloadHash` (e.g. `'jcs-rn-v1'`). */
  canonicalizerVersion?: string;
  /** Optional hardware-backed biometric assertion returned by `onBiometricAuth` / `onBiometricRequired`. */
  biometricAssertion?: string | Record<string, unknown>;
  /** `true` if execution was authorized by an active time-bound or session-scoped `SessionGrant`. */
  sessionGrantUsed?: boolean;
  /** Optional dry-run preview result computed by `tool.preview(args)`. */
  previewResult?: ToolPreviewResult;
  /** Optional error message if `tool.preview(args)` failed. */
  previewError?: string;
  /** Optional list of security threats detected in tool arguments by `threatScanner`. */
  threats?: ThreatDetection[];
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
  /** SHA-256 hex digest of the preceding audit log entry (or 64 zeros `'0'.repeat(64)` for the genesis entry). */
  prevHash: string;
  /** Deterministic SHA-256 hex digest of this entry (including `prevHash`). */
  entryHash: string;
}

/**
 * Structured telemetry payload emitted to `onAudit` / `onExecution` callbacks
 * after every approved, denied, biometric, or failed tool invocation.
 */
export interface AuditTelemetryEvent extends AuditLogEntry {
  /** ISO-8601 formatted timestamp string. */
  isoTimestamp: string;
  /** Normalized tool arguments (`parsedInput` if validated, otherwise `rawInput`). */
  arguments: unknown;
  /** High-level governance outcome (`'approved' | 'denied' | 'failed'`). */
  outcome: AuditOutcome;
  /** Execution duration in milliseconds (alias for `durationMs`). */
  duration: number;
}

/**
 * Callback invoked with a structured `AuditTelemetryEvent` after every tool execution attempt.
 */
export type AuditTelemetryCallback = (
  event: AuditTelemetryEvent,
) => void | Promise<void>;

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
  /** Optional TTL in milliseconds for queued user approval requests before rejecting with `GuardrailTimeoutError`. */
  approvalTimeoutMs?: number;
  /** Optional storage adapter for persisting pending approval requests across app restarts/backgrounding. */
  queueStorage?: QueueStorageAdapter;
  /** Optional time-bound session grant presets offered in `<AgentApprovalSheet />`. */
  sessionGrantOptions?: SessionGrantOption[];
  /** Whether active session grants may bypass `'biometric'` prompts globally. Defaults to `false`. */
  allowBiometricSessionGrants?: boolean;
  /** Handler invoked when a tool requires `'confirm'` approval. */
  onApprovalRequired?: ApprovalHandler;
  /** Handler invoked when a tool requires `'biometric'` authentication. Defaults to `expo-local-authentication` when omitted. */
  onBiometricRequired?: BiometricHandler;
  /**
   * Hardware-backed biometric attestation & authentication callback receiving
   * `(toolName, args, { payloadHash, schemaVersion, canonicalArgs })` and returning
   * `boolean` or `{ verified: boolean, biometricAssertion?: string | Record<string, unknown> }`.
   */
  onBiometricAuth?: BiometricAuthHandler;
  /** Optional configuration for native `expo-local-authentication` prompts when `policy: 'biometric'` is triggered. */
  biometricOptions?: BiometricAuthOptions;
  /** Optional persistent storage adapter (e.g. AsyncStorage or MMKV) for audit logs. */
  auditStorage?: AuditStorageAdapter;
  /** Storage key used when persisting audit logs. Defaults to `'@react-native-agent-guard/audit-log'`. */
  auditStorageKey?: string;
  /** Maximum number of audit entries retained in memory and storage. Defaults to `500`. */
  maxAuditEntries?: number;
  /**
   * Optional telemetry callback invoked after every approved, denied, or failed tool execution.
   */
  onAudit?: AuditTelemetryCallback;
  /**
   * Alias for `onAudit` — invoked with a structured telemetry payload on every tool execution outcome.
   */
  onExecution?: AuditTelemetryCallback;
  /**
   * Optional global agent loop protection and rate-limiting rules applied across registered tools.
   */
  rateLimit?: RateLimitConfig;
  /**
   * Built-in PII redaction and argument sanitization for audit logs and `onAudit`/`onExecution` telemetry.
   * Masks emails, phone numbers, credit cards, SSNs, JWT/Bearer tokens, and sensitive keys without mutating handler input.
   */
  redactPII?: PIIRedactionOption;
  /**
   * Optional input threat scanner middleware for detecting prompt injection, unsafe URLs / SSRF,
   * path traversal, SQL injection, command injection, and custom security rules.
   */
  threatScanner?: ThreatScannerOption;
}

/**
 * OpenAI function-calling tool schema format.
 */
export interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    strict?: boolean;
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
