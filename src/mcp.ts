import { z } from 'zod';
import type { ToolRegistry } from './registry';
import type { PolicyResolver } from './types';

/**
 * Tool descriptor returned by an MCP server's `tools/list` endpoint.
 */
export interface MCPToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 request envelope used by MCP.
 */
export interface MCPJsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC 2.0 response envelope returned by an MCP server.
 */
export interface MCPJsonRpcResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: TResult;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Configuration options for connecting to a remote SSE / HTTP JSON-RPC MCP server.
 */
export interface MCPSSETransportOptions {
  /** Remote MCP server SSE or JSON-RPC endpoint URL (e.g. `https://mcp.example.com/sse`). */
  url: string;
  /**
   * Optional explicit HTTP POST endpoint for JSON-RPC messages.
   * If omitted, discovered automatically from the SSE `endpoint` event or defaults to `url`.
   */
  postUrl?: string;
  /** Optional custom HTTP headers (e.g. `Authorization: Bearer <token>`). */
  headers?: Record<string, string>;
  /**
   * Default guardrail policy applied to dynamically registered MCP tools.
   * Defaults to `'confirm'` for safe human-in-the-loop execution of remote tools.
   */
  defaultPolicy?: PolicyResolver<unknown>;
  /** Optional per-tool policy overrides mapped by MCP tool name. */
  toolPolicies?: Record<string, PolicyResolver<unknown>>;
  /** Optional prefix prepended to registered tool names (e.g. `'mcp_'`). */
  toolPrefix?: string;
  /** Timeout in milliseconds for MCP network calls and tool executions. Defaults to `15000`. */
  timeoutMs?: number;
  /** Optional custom `fetch` implementation (useful for testing or custom networking). */
  fetchFn?: typeof fetch;
  /** Whether to send the MCP `initialize` handshake during `connect()`. Defaults to `true`. */
  initializeOnConnect?: boolean;
}

/**
 * Convert a JSON Schema (draft-07) property definition from an MCP `inputSchema`
 * into a runtime Zod v4 schema so `GuardrailRegistry` can validate LLM arguments.
 */
export function jsonSchemaToZod(
  schema?: Record<string, unknown>,
): z.ZodType {
  if (!schema || typeof schema !== 'object') {
    return z.record(z.string(), z.unknown());
  }

  const enumValues = schema.enum;
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const allStrings = enumValues.every((v) => typeof v === 'string');
    if (allStrings) {
      return z.enum(enumValues as [string, ...string[]]);
    }
  }

  const schemaType = schema.type;

  if (schemaType === 'string') {
    let strSchema = z.string();
    if (typeof schema.minLength === 'number') {
      strSchema = strSchema.min(schema.minLength);
    }
    if (typeof schema.maxLength === 'number') {
      strSchema = strSchema.max(schema.maxLength);
    }
    if (typeof schema.description === 'string') {
      strSchema = strSchema.describe(schema.description);
    }
    return strSchema;
  }

  if (schemaType === 'number' || schemaType === 'integer') {
    let numSchema = z.number();
    if (schemaType === 'integer') {
      numSchema = numSchema.int();
    }
    if (typeof schema.minimum === 'number') {
      numSchema = numSchema.min(schema.minimum);
    }
    if (typeof schema.maximum === 'number') {
      numSchema = numSchema.max(schema.maximum);
    }
    return numSchema;
  }

  if (schemaType === 'boolean') {
    return z.boolean();
  }

  if (schemaType === 'array') {
    const itemsSchema =
      schema.items && typeof schema.items === 'object'
        ? jsonSchemaToZod(schema.items as Record<string, unknown>)
        : z.unknown();
    return z.array(itemsSchema);
  }

  if (schemaType === 'object' || schema.properties) {
    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? (schema.properties as Record<string, Record<string, unknown>>)
        : {};
    const requiredList = Array.isArray(schema.required)
      ? (schema.required as string[])
      : [];
    const requiredSet = new Set(requiredList);

    const shape: Record<string, z.ZodType> = {};
    for (const [key, propSchema] of Object.entries(properties)) {
      const propZod = jsonSchemaToZod(propSchema);
      shape[key] = requiredSet.has(key) ? propZod : propZod.optional();
    }

    return z.object(shape);
  }

  return z.unknown();
}

/**
 * Parse Server-Sent Events (SSE) payload text to extract `event: endpoint` or `data: {...}` JSON-RPC messages.
 */
export function parseSSEMessages(rawText: string): {
  endpointUrl?: string;
  jsonRpcMessages: MCPJsonRpcResponse[];
} {
  let endpointUrl: string | undefined;
  const jsonRpcMessages: MCPJsonRpcResponse[] = [];

  const blocks = rawText.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let eventType = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith('event:')) {
        eventType = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }

    const dataPayload = dataLines.join('\n').trim();
    if (!dataPayload) {
      continue;
    }

    if (eventType === 'endpoint') {
      endpointUrl = dataPayload;
      continue;
    }

    try {
      const parsed = JSON.parse(dataPayload) as MCPJsonRpcResponse;
      if (parsed && typeof parsed === 'object' && 'jsonrpc' in parsed) {
        jsonRpcMessages.push(parsed);
      }
    } catch {
      // Ignore non-JSON SSE keepalive/comment frames
    }
  }

  return { endpointUrl, jsonRpcMessages };
}

/**
 * MCP SSE Transport Adapter for React Native & TypeScript.
 * Connects to a remote SSE-based MCP server, discovers available tools via `tools/list`,
 * converts their JSON Schemas to Zod validators, and registers them dynamically into a `ToolRegistry` / `GuardrailRegistry`.
 */
export class MCPSSETransportAdapter {
  private readonly options: MCPSSETransportOptions;
  private postEndpoint: string;
  private rpcId = 0;
  private connected = false;
  private abortController: AbortController | null = null;

  constructor(options: MCPSSETransportOptions) {
    if (!options?.url) {
      throw new Error('MCPSSETransportAdapter requires a valid server `url`.');
    }
    this.options = options;
    this.postEndpoint = options.postUrl ?? options.url;
  }

  /**
   * Returns whether the transport is currently connected.
   */
  public isConnected(): boolean {
    return this.connected;
  }

  /**
   * Returns the resolved HTTP POST endpoint for JSON-RPC messages.
   */
  public getPostEndpoint(): string {
    return this.postEndpoint;
  }

  /**
   * Connect to the remote MCP SSE server, resolve the session message endpoint if advertised via SSE,
   * and perform the MCP `initialize` handshake.
   */
  public async connect(): Promise<void> {
    const fetchImpl = this.options.fetchFn ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('Global `fetch` is unavailable in this environment.');
    }

    this.abortController = new AbortController();

    // If no explicit postUrl was provided, probe the SSE endpoint with Accept: text/event-stream
    if (!this.options.postUrl) {
      try {
        const response = await fetchImpl(this.options.url, {
          method: 'GET',
          headers: {
            Accept: 'text/event-stream',
            ...(this.options.headers ?? {}),
          },
          signal: this.abortController.signal,
        });

        const contentType = response.headers?.get?.('content-type') ?? '';
        if (response.ok && contentType.includes('text/event-stream')) {
          const text = await response.text();
          const { endpointUrl } = parseSSEMessages(text);
          if (endpointUrl) {
            this.postEndpoint = this.resolveUrl(this.options.url, endpointUrl);
          }
        }
      } catch {
        // Fallback to posting JSON-RPC directly to `options.url`
      }
    }

    if (this.options.initializeOnConnect !== false) {
      await this.sendRpcRequest('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'react-native-agent-guard',
          version: '0.1.4',
        },
      });
    }

    this.connected = true;
  }

  /**
   * Disconnect and abort any active requests.
   */
  public disconnect(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.connected = false;
  }

  /**
   * Fetch the list of available tools from the remote MCP server (`tools/list`).
   */
  public async listTools(): Promise<MCPToolDescriptor[]> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.sendRpcRequest<{ tools?: MCPToolDescriptor[] }>(
      'tools/list',
      {},
    );

    if (!result || !Array.isArray(result.tools)) {
      return [];
    }

    return result.tools;
  }

  /**
   * Execute a tool on the remote MCP server (`tools/call`).
   */
  public async callTool(
    name: string,
    args: unknown = {},
  ): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }

    const result = await this.sendRpcRequest<{
      content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
      isError?: boolean;
      [k: string]: unknown;
    }>('tools/call', {
      name,
      arguments: args ?? {},
    });

    if (result && result.isError) {
      const errorText =
        result.content
          ?.map((c) => c.text)
          .filter(Boolean)
          .join('\n') || `Remote MCP tool "${name}" returned isError=true.`;
      throw new Error(errorText);
    }

    return result;
  }

  /**
   * Fetch all available tools from the remote MCP server and register them
   * dynamically into the provided `ToolRegistry` or `GuardrailRegistry`.
   */
  public async registerTools(
    registry: ToolRegistry,
    overrides?: {
      defaultPolicy?: PolicyResolver<unknown>;
      toolPolicies?: Record<string, PolicyResolver<unknown>>;
      toolPrefix?: string;
    },
  ): Promise<MCPToolDescriptor[]> {
    const tools = await this.listTools();
    const defaultPolicy =
      overrides?.defaultPolicy ?? this.options.defaultPolicy ?? 'confirm';
    const toolPolicies = {
      ...(this.options.toolPolicies ?? {}),
      ...(overrides?.toolPolicies ?? {}),
    };
    const prefix = overrides?.toolPrefix ?? this.options.toolPrefix ?? '';

    for (const mcpTool of tools) {
      const registeredName = `${prefix}${mcpTool.name}`;
      const zodSchema = jsonSchemaToZod(mcpTool.inputSchema);
      const policy =
        toolPolicies[registeredName] ??
        toolPolicies[mcpTool.name] ??
        defaultPolicy;

      registry.register(registeredName, {
        description:
          mcpTool.description ?? `Remote MCP tool "${mcpTool.name}"`,
        inputSchema: zodSchema,
        policy,
        timeoutMs: this.options.timeoutMs,
        handler: async (parsedInput) => {
          return this.callTool(mcpTool.name, parsedInput);
        },
      });
    }

    return tools;
  }

  /**
   * Send a JSON-RPC 2.0 request to the MCP server (supporting both `application/json`
   * and `text/event-stream` responses).
   */
  public async sendRpcRequest<TResult = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<TResult> {
    const fetchImpl = this.options.fetchFn ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('Global `fetch` is unavailable in this environment.');
    }

    this.rpcId += 1;
    const requestId = this.rpcId;
    const payload: MCPJsonRpcRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method,
      ...(params ? { params } : {}),
    };

    const response = await fetchImpl(this.postEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.options.headers ?? {}),
      },
      body: JSON.stringify(payload),
      ...(this.abortController ? { signal: this.abortController.signal } : {}),
    });

    if (!response.ok) {
      throw new Error(
        `MCP server responded with HTTP ${response.status} for method "${method}".`,
      );
    }

    const contentType = response.headers?.get?.('content-type') ?? '';
    let rpcResponse: MCPJsonRpcResponse<TResult> | undefined;

    if (contentType.includes('text/event-stream')) {
      const rawText = await response.text();
      const { jsonRpcMessages } = parseSSEMessages(rawText);
      rpcResponse = (jsonRpcMessages.find((m) => m.id === requestId) ??
        jsonRpcMessages[0]) as MCPJsonRpcResponse<TResult> | undefined;
    } else {
      const rawText = await response.text();
      try {
        rpcResponse = JSON.parse(rawText) as MCPJsonRpcResponse<TResult>;
      } catch {
        const { jsonRpcMessages } = parseSSEMessages(rawText);
        rpcResponse = jsonRpcMessages[0] as
          | MCPJsonRpcResponse<TResult>
          | undefined;
      }
    }

    if (!rpcResponse) {
      throw new Error(
        `Empty or invalid JSON-RPC response from MCP server for method "${method}".`,
      );
    }

    if (rpcResponse.error) {
      throw new Error(
        `MCP RPC error (${rpcResponse.error.code}): ${rpcResponse.error.message}`,
      );
    }

    return rpcResponse.result as TResult;
  }

  private resolveUrl(baseUrl: string, maybeRelative: string): string {
    if (
      maybeRelative.startsWith('http://') ||
      maybeRelative.startsWith('https://')
    ) {
      return maybeRelative;
    }
    try {
      return new URL(maybeRelative, baseUrl).toString();
    } catch {
      const baseOrigin = baseUrl.replace(/\/[^/]*$/, '');
      const cleanRel = maybeRelative.startsWith('/')
        ? maybeRelative
        : `/${maybeRelative}`;
      return `${baseOrigin}${cleanRel}`;
    }
  }
}

/**
 * Factory function creating a new `MCPSSETransportAdapter` instance.
 */
export function createMCPSSETransport(
  options: MCPSSETransportOptions,
): MCPSSETransportAdapter {
  return new MCPSSETransportAdapter(options);
}
