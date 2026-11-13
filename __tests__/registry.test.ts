import React from 'react';
import { z } from 'zod';
import {
  AgentApprovalProvider,
  AgentApprovalSheet,
  createBleSyncToolPreset,
  createCalendarEventToolPreset,
  createGuardrails,
  createMCPSSETransport,
  createPaymentToolPreset,
  createToolRegistry,
  toLangChainTools,
  toVercelAITools,
  zodToClaudeSchema,
  zodToOpenAISchema,
  type AuditStorageAdapter,
  type AuditTelemetryEvent,
  type GuardrailConfig,
} from '../src';
import {
  claudeToolsPayload,
  langChainTools as exampleLangChainTools,
  openAIToolsPayload,
  vercelAITools as exampleVercelAITools,
} from '../examples/expo-example/App';

describe('react-native-agent-guard — ToolRegistry & Presets', () => {
  describe('1. auto policy execution & stringified JSON parsing', () => {
    it('executes an auto policy tool with object input and records durationMs', async () => {
      const registry = createToolRegistry();

      registry.register('get_weather', {
        description: 'Fetch weather for a city',
        inputSchema: z.object({
          city: z.string().min(1),
          unit: z.enum(['celsius', 'fahrenheit']).default('celsius'),
        }),
        policy: 'auto',
        handler: async ({ city, unit }) => ({
          city,
          temperature: unit === 'celsius' ? 22 : 72,
          unit,
        }),
      });

      const result = await registry.execute('get_weather', {
        city: 'Tokyo',
      });

      expect(result.success).toBe(true);
      expect(result.policy).toBe('auto');
      expect(result.data).toEqual({
        city: 'Tokyo',
        temperature: 22,
        unit: 'celsius',
      });
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('safely parses stringified JSON passed by an LLM', async () => {
      const registry = createToolRegistry();

      registry.register('add_numbers', {
        description: 'Add two numbers together',
        inputSchema: z.object({
          a: z.number(),
          b: z.number(),
        }),
        policy: 'auto',
        handler: ({ a, b }) => ({ sum: a + b }),
      });

      const rawJsonString = '  { "a": 15, "b": 27 }  ';
      const result = await registry.execute<{ sum: number }>(
        'add_numbers',
        rawJsonString,
      );

      expect(result.success).toBe(true);
      expect(result.data?.sum).toBe(42);
    });
  });

  describe('2. Zod validation failure & llmFeedback formatting', () => {
    it('returns a structured VALIDATION_ERROR and actionable llmFeedback without throwing', async () => {
      const registry = createToolRegistry();
      const handler = jest.fn();

      registry.register('update_profile', {
        description: 'Update user profile details',
        inputSchema: z.object({
          username: z.string().min(3, 'Username must have at least 3 chars'),
          age: z.number().int().min(18, 'Must be at least 18 years old'),
        }),
        policy: 'auto',
        handler,
      });

      const result = await registry.execute('update_profile', {
        username: 'ab',
        age: 14,
      });

      expect(handler).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.error?.code).toBe('VALIDATION_ERROR');
      expect(result.error?.issues).toBeDefined();
      expect(result.llmFeedback).toBeDefined();
      expect(result.llmFeedback).toContain('update_profile');
      expect(result.llmFeedback).toContain('username');
      expect(result.llmFeedback).toContain('age');
    });

    it('handles malformed JSON strings gracefully with VALIDATION_ERROR and JSON hint in llmFeedback', async () => {
      const registry = createToolRegistry();

      registry.register('strict_json_tool', {
        description: 'Requires valid object',
        inputSchema: z.object({ query: z.string() }),
        policy: 'auto',
        handler: ({ query }) => query,
      });

      const result = await registry.execute(
        'strict_json_tool',
        '{ invalid json ',
      );

      expect(result.success).toBe(false);
      expect(result.code).toBe('VALIDATION_ERROR');
      expect(result.llmFeedback).toContain('failed JSON.parse');
    });
  });

  describe('3. Dynamic policy function evaluation', () => {
    it('auto-approves amounts <= 50 and requires confirm for amounts > 50', async () => {
      const onApprovalRequired = jest.fn().mockResolvedValue(true);
      const registry = createToolRegistry({ onApprovalRequired });

      registry.register('transfer_funds', {
        description: 'Transfer money to a contact',
        inputSchema: z.object({
          to: z.string(),
          amount: z.number().positive(),
        }),
        policy: async (parsedInput) =>
          parsedInput.amount <= 50 ? 'auto' : 'confirm',
        handler: ({ to, amount }) => ({ transferred: amount, to }),
      });

      // Low value (<= 50) -> auto
      const lowResult = await registry.execute('transfer_funds', {
        to: 'alice',
        amount: 50,
      });
      expect(lowResult.success).toBe(true);
      expect(lowResult.policy).toBe('auto');
      expect(onApprovalRequired).not.toHaveBeenCalled();

      // High value (> 50) -> confirm
      const highResult = await registry.execute('transfer_funds', {
        to: 'bob',
        amount: 125,
      });
      expect(highResult.success).toBe(true);
      expect(highResult.policy).toBe('confirm');
      expect(onApprovalRequired).toHaveBeenCalledTimes(1);
      expect(onApprovalRequired).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: 'transfer_funds',
          policy: 'confirm',
          input: { to: 'bob', amount: 125 },
        }),
      );
    });
  });

  describe('4. confirm, biometric, and deny policy flows', () => {
    it('executes handler when confirm policy is approved and blocks when denied', async () => {
      let shouldApprove = true;
      const onApprovalRequired = jest.fn(async () => shouldApprove);
      const handler = jest.fn(({ file }: { file: string }) => ({
        deleted: file,
      }));

      const registry = createToolRegistry({ onApprovalRequired });
      registry.register('delete_file', {
        description: 'Delete a local file',
        inputSchema: z.object({ file: z.string() }),
        policy: 'confirm',
        handler,
      });

      // Approved flow
      const approvedRes = await registry.execute('delete_file', {
        file: 'cache.tmp',
      });
      expect(approvedRes.success).toBe(true);
      expect(approvedRes.data).toEqual({ deleted: 'cache.tmp' });
      expect(handler).toHaveBeenCalledTimes(1);

      // Denied flow
      shouldApprove = false;
      const deniedRes = await registry.execute('delete_file', {
        file: 'important.db',
      });
      expect(deniedRes.success).toBe(false);
      expect(deniedRes.code).toBe('USER_DENIED');
      expect(deniedRes.llmFeedback).toContain('declined');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('executes handler when biometric policy succeeds and blocks when biometric fails', async () => {
      let biometricSuccess = true;
      const onBiometricRequired = jest.fn(async () => biometricSuccess);
      const handler = jest.fn(() => ({ unlocked: true }));

      const registry = createToolRegistry({ onBiometricRequired });
      registry.register('unlock_vault', {
        description: 'Unlock encrypted key vault',
        inputSchema: z.object({ vaultId: z.string() }),
        policy: 'biometric',
        handler,
      });

      const okRes = await registry.execute('unlock_vault', {
        vaultId: 'primary',
      });
      expect(okRes.success).toBe(true);
      expect(okRes.policy).toBe('biometric');
      expect(onBiometricRequired).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledTimes(1);

      biometricSuccess = false;
      const failRes = await registry.execute('unlock_vault', {
        vaultId: 'primary',
      });
      expect(failRes.success).toBe(false);
      expect(failRes.code).toBe('BIOMETRIC_FAILED');
      expect(failRes.error?.code).toBe('BIOMETRIC_FAILED');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('blocks execution unconditionally when policy resolves to deny', async () => {
      const handler = jest.fn();
      const registry = createToolRegistry();

      registry.register('factory_reset', {
        description: 'Wipe device data',
        inputSchema: z.object({}),
        policy: 'deny',
        handler,
      });

      const res = await registry.execute('factory_reset', {});
      expect(res.success).toBe(false);
      expect(res.code).toBe('DENIED_BY_POLICY');
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('5. Timeout enforcement without memory leaks', () => {
    it('enforces timeoutMs using Promise.race and clears timer in finally', async () => {
      const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
      const registry = createToolRegistry();

      registry.register('fast_tool', {
        description: 'Completes quickly before timeout',
        inputSchema: z.object({ value: z.number() }),
        policy: 'auto',
        timeoutMs: 2000,
        handler: async ({ value }) => value * 2,
      });

      const fastRes = await registry.execute('fast_tool', { value: 21 });
      expect(fastRes.success).toBe(true);
      expect(fastRes.data).toBe(42);
      expect(clearTimeoutSpy).toHaveBeenCalled();

      let slowTimer: ReturnType<typeof setTimeout> | undefined;
      registry.register('hanging_tool', {
        description: 'Simulates a hung network call',
        inputSchema: z.object({}),
        policy: 'auto',
        timeoutMs: 40,
        handler: () =>
          new Promise((resolve) => {
            slowTimer = setTimeout(() => resolve('too late'), 5000);
          }),
      });

      const timeoutRes = await registry.execute('hanging_tool', {});
      if (slowTimer) {
        clearTimeout(slowTimer);
      }

      expect(timeoutRes.success).toBe(false);
      expect(timeoutRes.code).toBe('TIMEOUT_ERROR');
      expect(timeoutRes.error?.code).toBe('TIMEOUT_ERROR');
      expect(timeoutRes.llmFeedback).toContain('timed out after 40ms');

      clearTimeoutSpy.mockRestore();
    });
  });

  describe('6. OpenAI, Claude, and MCP JSON Schema exports', () => {
    it('exports draft-07 JSON schemas for OpenAI, Claude, and MCP', () => {
      const registry = createToolRegistry();

      registry.register('search_contacts', {
        description: 'Search address book contacts by name',
        inputSchema: z.object({
          query: z.string().describe('Search substring'),
          limit: z.number().int().optional(),
        }),
        policy: 'auto',
        handler: () => [],
      });

      const openAITools = registry.toOpenAITools();
      expect(openAITools).toHaveLength(1);
      expect(openAITools[0]).toEqual({
        type: 'function',
        function: {
          name: 'search_contacts',
          description: 'Search address book contacts by name',
          parameters: expect.objectContaining({
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: expect.objectContaining({
              query: expect.objectContaining({ type: 'string' }),
            }),
            required: ['query'],
          }),
        },
      });

      const claudeTools = registry.toClaudeTools();
      expect(claudeTools).toHaveLength(1);
      expect(claudeTools[0]).toEqual({
        name: 'search_contacts',
        description: 'Search address book contacts by name',
        input_schema: expect.objectContaining({
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          required: ['query'],
        }),
      });

      const mcpTools = registry.toMCPTools();
      expect(mcpTools).toHaveLength(1);
      expect(mcpTools[0]).toEqual({
        name: 'search_contacts',
        description: 'Search address book contacts by name',
        inputSchema: expect.objectContaining({
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          required: ['query'],
        }),
      });
    });

    it('safely exports OpenAI strict and Claude schemas for complex Zod schemas using .transform() and .refine()', async () => {
      const registry = createToolRegistry();

      const refinedPaymentSchema = z
        .object({
          recipient: z
            .string()
            .min(1)
            .transform((val) => val.trim().toLowerCase()),
          amount: z
            .number()
            .positive()
            .refine((val) => val <= 10_000, {
              message: 'Single transfer cannot exceed 10,000',
            }),
          currency: z
            .string()
            .length(3)
            .transform((c) => c.toUpperCase()),
        })
        .refine((data) => data.recipient !== 'blocked_user', {
          message: 'Transfers to blocked_user are not allowed',
          path: ['recipient'],
        });

      registry.register('refined_transfer', {
        description: 'Transfer funds with .transform() and .refine() rules',
        inputSchema: refinedPaymentSchema,
        policy: 'auto',
        handler: (input) => input,
      });

      // Exporting to OpenAI (with strict: true), Claude, and MCP must not throw on .transform() or .refine()
      const openAIStrict = registry.toOpenAITools({ strict: true });
      expect(openAIStrict).toHaveLength(1);
      expect(openAIStrict[0]?.function.strict).toBe(true);
      expect(openAIStrict[0]?.function.parameters).toEqual(
        expect.objectContaining({
          type: 'object',
          additionalProperties: false,
          properties: expect.objectContaining({
            recipient: expect.objectContaining({ type: 'string' }),
            amount: expect.objectContaining({ type: 'number' }),
            currency: expect.objectContaining({ type: 'string' }),
          }),
        }),
      );

      const claudeSchemas = registry.toClaudeTools({ strict: true });
      expect(claudeSchemas).toHaveLength(1);
      expect(claudeSchemas[0]?.input_schema).toEqual(
        expect.objectContaining({
          type: 'object',
          additionalProperties: false,
        }),
      );

      // Runtime execution applies .transform() and .refine()
      const okResult = await registry.execute('refined_transfer', {
        recipient: '  Alice@Example.com  ',
        amount: 250,
        currency: 'gbp',
      });
      expect(okResult.success).toBe(true);
      expect(okResult.data).toEqual({
        recipient: 'alice@example.com',
        amount: 250,
        currency: 'GBP',
      });

      const failedRefine = await registry.execute('refined_transfer', {
        recipient: 'blocked_user',
        amount: 250,
        currency: 'usd',
      });
      expect(failedRefine.success).toBe(false);
      expect(failedRefine.code).toBe('VALIDATION_ERROR');
      expect(failedRefine.llmFeedback).toContain('blocked_user');
    });
  });

  describe('7. Built-in mobile tool presets & AuditStorageAdapter', () => {
    it('creates and executes payment, BLE sync, and calendar event presets and logs to AuditStorageAdapter', async () => {
      const memoryStore = new Map<string, string>();
      const auditStorage: AuditStorageAdapter = {
        getItem: (key) => memoryStore.get(key) ?? null,
        setItem: (key, val) => {
          memoryStore.set(key, val);
        },
      };

      const registry = createToolRegistry({
        auditStorage,
        onApprovalRequired: async () => true,
        onBiometricRequired: async () => true,
      });

      const paymentPreset = createPaymentToolPreset({ autoApproveLimit: 50 });
      const blePreset = createBleSyncToolPreset();
      const calendarPreset = createCalendarEventToolPreset();

      registry
        .register(paymentPreset.name, paymentPreset)
        .register(blePreset.name, blePreset)
        .register(calendarPreset.name, calendarPreset);

      // 1) Payment preset <= 50 (auto) and > 50 (biometric)
      const smallPayment = await registry.execute(paymentPreset.name, {
        recipient: 'merchant_123',
        amount: 25,
        currency: 'USD',
      });
      expect(smallPayment.success).toBe(true);
      expect(smallPayment.policy).toBe('auto');

      const largePayment = await registry.execute(paymentPreset.name, {
        recipient: 'merchant_123',
        amount: 250,
        currency: 'USD',
      });
      expect(largePayment.success).toBe(true);
      expect(largePayment.policy).toBe('biometric');

      // 2) BLE Sync preset
      const bleResult = await registry.execute(blePreset.name, {
        deviceId: 'AA:BB:CC:DD:EE:FF',
        serviceUuid: '180D',
        payloadHex: '01020304',
      });
      expect(bleResult.success).toBe(true);
      expect(bleResult.policy).toBe('confirm');
      expect(bleResult.data).toEqual(
        expect.objectContaining({
          deviceId: 'AA:BB:CC:DD:EE:FF',
          syncedBytes: 4,
          status: 'SYNCED',
        }),
      );

      // 3) Calendar Event preset
      const calResult = await registry.execute(calendarPreset.name, {
        title: 'Design Review',
        startIso: '2026-11-10T10:00:00Z',
        endIso: '2026-11-10T10:30:00Z',
      });
      expect(calResult.success).toBe(true);
      expect(calResult.policy).toBe('auto');

      // Verify in-memory and persistent audit logs
      const auditEntries = registry.getAuditLog();
      expect(auditEntries).toHaveLength(4);
      expect(auditEntries.every((e) => typeof e.durationMs === 'number')).toBe(
        true,
      );

      const persistedRaw = memoryStore.get(
        '@react-native-agent-guard/audit-log',
      );
      expect(persistedRaw).toBeDefined();
      const persistedEntries = JSON.parse(persistedRaw!);
      expect(persistedEntries).toHaveLength(4);
    });

    it('exposes AgentApprovalProvider and AgentApprovalSheet components', () => {
      expect(typeof AgentApprovalProvider).toBe('function');
      expect(typeof AgentApprovalSheet).toBe('function');
      const registry = createToolRegistry();
      const element = React.createElement(
        AgentApprovalProvider,
        { registry, children: React.createElement(AgentApprovalSheet) },
      );
      expect(element).toBeDefined();
    });
  });

  describe('8. createGuardrails & GuardrailConfig permission checks', () => {
    it('applies custom defaultPolicy, per-tool permissions, blockedTools, and checkToolPermission', async () => {
      const config: GuardrailConfig = {
        defaultPolicy: 'confirm',
        permissions: {
          read_status: 'auto',
        },
        blockedTools: ['dangerous_reset'],
        onApprovalRequired: async () => true,
      };

      const guardrails = createGuardrails(config);

      guardrails
        .register('read_status', {
          description: 'Read device status',
          inputSchema: z.object({}),
          handler: () => ({ ok: true }),
        })
        .register('write_setting', {
          description: 'Modify device setting (inherits defaultPolicy confirm)',
          inputSchema: z.object({ key: z.string() }),
          handler: ({ key }) => ({ updated: key }),
        })
        .register('dangerous_reset', {
          description: 'Blocked tool',
          inputSchema: z.object({}),
          policy: 'auto',
          handler: () => ({ reset: true }),
        });

      expect(await guardrails.checkToolPermission('read_status')).toBe('auto');
      expect(await guardrails.checkToolPermission('write_setting')).toBe(
        'confirm',
      );
      expect(await guardrails.checkToolPermission('dangerous_reset')).toBe(
        'deny',
      );

      const readRes = await guardrails.execute('read_status', {});
      expect(readRes.success).toBe(true);
      expect(readRes.policy).toBe('auto');

      const writeRes = await guardrails.execute('write_setting', {
        key: 'theme',
      });
      expect(writeRes.success).toBe(true);
      expect(writeRes.policy).toBe('confirm');

      const blockedRes = await guardrails.execute('dangerous_reset', {});
      expect(blockedRes.success).toBe(false);
      expect(blockedRes.code).toBe('DENIED_BY_POLICY');
    });

    it('automatically triggers expo-local-authentication prompt when policy is biometric', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LocalAuthentication = require('expo-local-authentication') as {
        authenticateAsync: jest.Mock;
      };

      const guardrails = createGuardrails({
        biometricOptions: {
          promptMessage: (req) => `Confirm FaceID for ${req.toolName}`,
        },
      }).register('export_private_key', {
        description: 'Export encrypted wallet private key',
        inputSchema: z.object({ accountId: z.string() }),
        policy: 'biometric',
        handler: ({ accountId }) => ({ exported: true, accountId }),
      });

      LocalAuthentication.authenticateAsync.mockResolvedValueOnce({
        success: true,
      });

      const okRes = await guardrails.execute('export_private_key', {
        accountId: 'acc_01',
      });
      expect(okRes.success).toBe(true);
      expect(okRes.policy).toBe('biometric');
      expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          promptMessage: 'Confirm FaceID for export_private_key',
        }),
      );

      LocalAuthentication.authenticateAsync.mockResolvedValueOnce({
        success: false,
      });

      const failRes = await guardrails.execute('export_private_key', {
        accountId: 'acc_01',
      });
      expect(failRes.success).toBe(false);
      expect(failRes.code).toBe('BIOMETRIC_FAILED');
    });
  });

  describe('9. Model Context Protocol (MCP) SSE Transport Adapter', () => {
    it('connects to a remote SSE MCP server, discovers tools, validates schemas, and executes tools through GuardrailRegistry', async () => {
      const mockFetch = jest.fn(async (url: string, init?: RequestInit) => {
        // 1) Initial GET to SSE stream advertising session message endpoint
        if (!init?.method || init.method === 'GET') {
          return {
            ok: true,
            status: 200,
            headers: {
              get: () => 'text/event-stream',
            },
            text: async () =>
              'event: endpoint\ndata: /mcp/messages?sessionId=abc123\n\n',
          } as unknown as Response;
        }

        // 2) JSON-RPC POST requests
        const body = JSON.parse(String(init.body));
        if (body.method === 'initialize') {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () =>
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: {
                  protocolVersion: '2024-11-05',
                  serverInfo: { name: 'mock-mcp-server', version: '1.0.0' },
                },
              }),
          } as unknown as Response;
        }

        if (body.method === 'tools/list') {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'text/event-stream' },
            text: async () =>
              `event: message\ndata: ${JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: {
                  tools: [
                    {
                      name: 'create_github_issue',
                      description: 'Create an issue in a GitHub repository',
                      inputSchema: {
                        type: 'object',
                        properties: {
                          repo: { type: 'string', minLength: 3 },
                          title: { type: 'string', minLength: 1 },
                          priority: {
                            type: 'string',
                            enum: ['low', 'medium', 'high'],
                          },
                        },
                        required: ['repo', 'title'],
                      },
                    },
                  ],
                },
              })}\n\n`,
          } as unknown as Response;
        }

        if (body.method === 'tools/call') {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'application/json' },
            text: async () =>
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: {
                  content: [
                    {
                      type: 'text',
                      text: `Issue "${body.params.arguments.title}" created in ${body.params.arguments.repo}`,
                    },
                  ],
                  issueNumber: 404,
                },
              }),
          } as unknown as Response;
        }

        throw new Error(`Unexpected RPC method: ${body.method}`);
      });

      const onApprovalRequired = jest.fn(async () => true);
      const guardrails = createGuardrails({
        defaultPolicy: 'confirm',
        onApprovalRequired,
      });

      const transport = createMCPSSETransport({
        url: 'https://mcp.example.com/sse',
        defaultPolicy: 'confirm',
        fetchFn: mockFetch as unknown as typeof fetch,
      });

      const { tools } = await guardrails.connectMCP(transport);

      expect(tools).toHaveLength(1);
      expect(tools[0]?.name).toBe('create_github_issue');
      expect(transport.getPostEndpoint()).toBe(
        'https://mcp.example.com/mcp/messages?sessionId=abc123',
      );
      expect(guardrails.getToolNames()).toContain('create_github_issue');

      // Validate that converted JSON Schema catches invalid inputs before hitting remote server
      const invalidRes = await guardrails.execute('create_github_issue', {
        repo: 'ab', // minLength is 3
      });
      expect(invalidRes.success).toBe(false);
      expect(invalidRes.code).toBe('VALIDATION_ERROR');

      // Valid input triggers 'confirm' policy and executes remote MCP tool call
      const validRes = await guardrails.execute<{ issueNumber: number }>(
        'create_github_issue',
        {
          repo: 'muhammadhassaan/react-native-agent-guard',
          title: 'Support MCP SSE transport',
          priority: 'high',
        },
      );

      expect(validRes.success).toBe(true);
      expect(validRes.policy).toBe('confirm');
      expect(onApprovalRequired).toHaveBeenCalledTimes(1);
      expect(validRes.data?.issueNumber).toBe(404);

      transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });
  });

  describe('10. Global Audit & Execution Telemetry Callbacks (onAudit / onExecution)', () => {
    it('emits structured telemetry payloads for approved, denied, and failed tool executions', async () => {
      const events: AuditTelemetryEvent[] = [];
      const onExecution = jest.fn();

      const guardrails = createGuardrails({
        defaultPolicy: 'auto',
        onAudit: (event) => {
          events.push(event);
        },
        onExecution,
      });

      const runtimeListener = jest.fn();
      const unsubscribe = guardrails.onAudit(runtimeListener);

      guardrails
        .register('send_notification', {
          description: 'Send push notification',
          inputSchema: z.object({ title: z.string().min(3) }),
          policy: 'auto',
          handler: ({ title }) => ({ delivered: title }),
        })
        .register('restricted_action', {
          description: 'Restricted admin tool',
          inputSchema: z.object({ reason: z.string() }),
          policy: 'deny',
          handler: () => ({ ok: true }),
        });

      // 1) Approved execution
      await guardrails.execute('send_notification', { title: 'Hello Agent' });

      // 2) Denied execution
      await guardrails.execute('restricted_action', { reason: 'test' });

      // 3) Failed validation execution
      await guardrails.execute('send_notification', { title: 'Hi' });

      expect(events).toHaveLength(3);
      expect(onExecution).toHaveBeenCalledTimes(3);
      expect(runtimeListener).toHaveBeenCalledTimes(3);

      expect(events[0]).toEqual(
        expect.objectContaining({
          toolName: 'send_notification',
          arguments: { title: 'Hello Agent' },
          policy: 'auto',
          status: 'SUCCESS',
          outcome: 'approved',
        }),
      );
      expect(typeof events[0]?.isoTimestamp).toBe('string');

      expect(events[1]).toEqual(
        expect.objectContaining({
          toolName: 'restricted_action',
          arguments: { reason: 'test' },
          policy: 'deny',
          status: 'DENIED_BY_POLICY',
          outcome: 'denied',
        }),
      );

      expect(events[2]).toEqual(
        expect.objectContaining({
          toolName: 'send_notification',
          status: 'VALIDATION_ERROR',
          outcome: 'failed',
        }),
      );

      unsubscribe();
      await guardrails.execute('send_notification', { title: 'After Unsub' });
      expect(runtimeListener).toHaveBeenCalledTimes(3);
    });
  });

  describe('11. Framework Adapters (toVercelAITools & toLangChainTools)', () => {
    it('routes Vercel AI SDK and LangChain.js tool executions through GuardrailRegistry policies and biometric gates', async () => {
      const onApprovalRequired = jest.fn(async () => true);
      const guardrails = createGuardrails({
        defaultPolicy: 'confirm',
        onApprovalRequired,
      });

      guardrails.register('book_flight', {
        description: 'Book a flight ticket',
        inputSchema: z.object({
          destination: z.string().min(3),
          seatClass: z.enum(['economy', 'business']).default('economy'),
        }),
        policy: 'confirm',
        handler: ({ destination, seatClass }) => ({
          bookingRef: 'FL_9900',
          destination,
          seatClass,
        }),
      });

      // 1) Vercel AI SDK Adapter
      const vercelTools = guardrails.toVercelAITools({ unwrapData: true });
      expect(vercelTools.book_flight).toBeDefined();
      expect(vercelTools.book_flight?.description).toBe('Book a flight ticket');
      expect(vercelTools.book_flight?.parameters).toBeDefined();

      const vercelOutput = await vercelTools.book_flight!.execute({
        destination: 'London',
        seatClass: 'business',
      });
      expect(onApprovalRequired).toHaveBeenCalledTimes(1);
      expect(vercelOutput).toEqual({
        bookingRef: 'FL_9900',
        destination: 'London',
        seatClass: 'business',
      });

      // 2) LangChain.js Adapter
      const langChainTools = toLangChainTools(guardrails, { unwrapData: true });
      expect(langChainTools).toHaveLength(1);
      const lcFlightTool = langChainTools[0]!;
      expect(lcFlightTool.name).toBe('book_flight');

      const lcInvokeResult = await lcFlightTool.invoke({
        destination: 'Tokyo',
      });
      expect(onApprovalRequired).toHaveBeenCalledTimes(2);
      expect(lcInvokeResult).toEqual({
        bookingRef: 'FL_9900',
        destination: 'Tokyo',
        seatClass: 'economy',
      });

      const lcFuncJson = await lcFlightTool.func({
        destination: 'Paris',
      });
      expect(JSON.parse(lcFuncJson)).toEqual({
        bookingRef: 'FL_9900',
        destination: 'Paris',
        seatClass: 'economy',
      });
    });

    it('supports throwOnError and structured error feedback in Vercel AI SDK & LangChain adapters', async () => {
      const guardrails = createGuardrails({
        defaultPolicy: 'deny',
      }).register('admin_purge', {
        description: 'Purge database',
        inputSchema: z.object({ confirmCode: z.string() }),
        policy: 'deny',
        handler: () => ({ purged: true }),
      });

      const vercelSafe = toVercelAITools(guardrails, { unwrapData: true });
      const blockedRes = await vercelSafe.admin_purge!.execute({
        confirmCode: '123',
      });
      expect(blockedRes).toEqual(
        expect.objectContaining({
          success: false,
          error: 'DENIED_BY_POLICY',
        }),
      );

      const vercelThrowing = toVercelAITools(guardrails, {
        throwOnError: true,
      });
      await expect(
        vercelThrowing.admin_purge!.execute({ confirmCode: '123' }),
      ).rejects.toThrow(/denied by security policy/i);

      const lcThrowing = toLangChainTools(guardrails, { throwOnError: true });
      await expect(
        lcThrowing[0]!.invoke({ confirmCode: '123' }),
      ).rejects.toThrow(/denied by security policy/i);
    });
  });

  describe('12. Edge Cases & Example App Integration', () => {
    it('handles nested objects, arrays, and .superRefine() in zodToOpenAISchema & zodToClaudeSchema', () => {
      const complexSchema = z
        .object({
          metadata: z.object({
            source: z.string().transform((s) => s.trim()),
          }),
          tags: z.array(
            z.object({
              key: z.string(),
              value: z.string(),
            }),
          ),
        })
        .superRefine((val, ctx) => {
          if (val.tags.length === 0) {
            ctx.addIssue({
              code: 'custom',
              message: 'At least one tag is required',
              path: ['tags'],
            });
          }
        });

      const openAISchema = zodToOpenAISchema(
        'tag_resource',
        'Tag a cloud resource',
        complexSchema,
        { strict: true },
      );
      expect(openAISchema.function.strict).toBe(true);
      expect(openAISchema.function.parameters.additionalProperties).toBe(false);

      const claudeSchema = zodToClaudeSchema(
        'tag_resource',
        'Tag a cloud resource',
        complexSchema,
        { strict: true },
      );
      expect(claudeSchema.input_schema.additionalProperties).toBe(false);
    });

    it('rejects biometric execution when hardware is missing or not enrolled', async () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const LocalAuthentication = require('expo-local-authentication') as {
        hasHardwareAsync: jest.Mock;
        isEnrolledAsync: jest.Mock;
      };

      const guardrails = createGuardrails().register('biometric_only', {
        description: 'Requires enrolled biometrics',
        inputSchema: z.object({}),
        policy: 'biometric',
        handler: () => ({ ok: true }),
      });

      LocalAuthentication.hasHardwareAsync.mockResolvedValueOnce(false);
      const noHwRes = await guardrails.execute('biometric_only', {});
      expect(noHwRes.success).toBe(false);
      expect(noHwRes.code).toBe('BIOMETRIC_FAILED');

      LocalAuthentication.hasHardwareAsync.mockResolvedValueOnce(true);
      LocalAuthentication.isEnrolledAsync.mockResolvedValueOnce(false);
      const notEnrolledRes = await guardrails.execute('biometric_only', {});
      expect(notEnrolledRes.success).toBe(false);
      expect(notEnrolledRes.code).toBe('BIOMETRIC_FAILED');
    });

    it('enforces allowedTools and boolean checkPermission in GuardrailRegistry', async () => {
      const guardrails = createGuardrails({
        allowedTools: ['permitted_tool'],
        checkPermission: (toolName, input) => {
          if (
            toolName === 'permitted_tool' &&
            typeof input === 'object' &&
            input !== null &&
            (input as { block?: boolean }).block
          ) {
            return false;
          }
          return true;
        },
      })
        .register('permitted_tool', {
          description: 'Allowed tool',
          inputSchema: z.object({ block: z.boolean().optional() }),
          policy: 'auto',
          handler: () => ({ ok: true }),
        })
        .register('unlisted_tool', {
          description: 'Not in allowedTools',
          inputSchema: z.object({}),
          policy: 'auto',
          handler: () => ({ ok: true }),
        });

      const unlistedRes = await guardrails.execute('unlisted_tool', {});
      expect(unlistedRes.success).toBe(false);
      expect(unlistedRes.code).toBe('DENIED_BY_POLICY');

      const blockedByHook = await guardrails.execute('permitted_tool', {
        block: true,
      });
      expect(blockedByHook.success).toBe(false);
      expect(blockedByHook.code).toBe('DENIED_BY_POLICY');

      const allowedRes = await guardrails.execute('permitted_tool', {
        block: false,
      });
      expect(allowedRes.success).toBe(true);
    });

    it('aligns cleanly with exported payloads and adapters in examples/expo-example/App.tsx', () => {
      expect(openAIToolsPayload).toHaveLength(2);
      expect(openAIToolsPayload[0]?.function.strict).toBe(true);
      expect(claudeToolsPayload).toHaveLength(2);
      expect(exampleVercelAITools.transfer_funds).toBeDefined();
      expect(exampleVercelAITools.wire_transfer_biometric).toBeDefined();
      expect(exampleLangChainTools).toHaveLength(2);
    });
  });

  describe('13. Agent Loop Protection & Rate Limiting (rateLimit)', () => {
    it('blocks runaway agent loops with RATE_LIMITED error and self-correcting llmFeedback when quota is exceeded', async () => {
      const handler = jest.fn(({ query }: { query: string }) => ({
        results: [query],
      }));

      const guardrails = createGuardrails({
        defaultPolicy: 'auto',
        rateLimit: {
          maxCallsPerMinute: 2,
          maxSessionCalls: 3,
          onLimitExceeded: 'deny',
        },
      }).register('search_knowledge_base', {
        description: 'Search local knowledge base',
        inputSchema: z.object({ query: z.string() }),
        policy: 'auto',
        handler,
      });

      const call1 = await guardrails.execute('search_knowledge_base', {
        query: 'q1',
      });
      const call2 = await guardrails.execute('search_knowledge_base', {
        query: 'q2',
      });
      const call3 = await guardrails.execute('search_knowledge_base', {
        query: 'q3',
      });

      expect(call1.success).toBe(true);
      expect(call2.success).toBe(true);
      expect(call3.success).toBe(false);
      expect(call3.code).toBe('RATE_LIMITED');
      expect(call3.error?.code).toBe('RATE_LIMITED');
      expect(call3.llmFeedback).toContain('Stop retrying tool');
      expect(handler).toHaveBeenCalledTimes(2);

      // Reset rate limits and verify execution succeeds again
      guardrails.resetRateLimits('search_knowledge_base');
      const afterReset = await guardrails.execute('search_knowledge_base', {
        query: 'q4',
      });
      expect(afterReset.success).toBe(true);
    });

    it('escalates policy from auto to confirm or biometric when onLimitExceeded is configured to escalate', async () => {
      const onApprovalRequired = jest.fn(async () => true);

      const guardrails = createGuardrails({
        defaultPolicy: 'auto',
        onApprovalRequired,
      }).register('send_sms', {
        description: 'Send an SMS message',
        inputSchema: z.object({ to: z.string(), body: z.string() }),
        policy: 'auto',
        rateLimit: {
          maxSessionCalls: 1,
          onLimitExceeded: 'confirm',
        },
        handler: ({ to }) => ({ sentTo: to }),
      });

      // 1st call is within maxSessionCalls (1) -> executes with 'auto' policy
      const first = await guardrails.execute('send_sms', {
        to: '+15550001',
        body: 'First SMS',
      });
      expect(first.success).toBe(true);
      expect(first.policy).toBe('auto');
      expect(onApprovalRequired).not.toHaveBeenCalled();

      // 2nd call exceeds maxSessionCalls (1) -> escalates from 'auto' to 'confirm'
      const second = await guardrails.execute('send_sms', {
        to: '+15550002',
        body: 'Second SMS',
      });
      expect(second.success).toBe(true);
      expect(second.policy).toBe('confirm');
      expect(onApprovalRequired).toHaveBeenCalledTimes(1);
    });
  });

  describe('14. Built-In PII Redaction & Argument Sanitization (redactPII)', () => {
    it('redacts emails, phones, cards, SSNs, JWT/Bearer tokens, and sensitive keys in onAudit and AuditStorageAdapter without mutating handler input', async () => {
      const memoryStore = new Map<string, string>();
      const auditStorage: AuditStorageAdapter = {
        getItem: (key) => memoryStore.get(key) ?? null,
        setItem: (key, val) => {
          memoryStore.set(key, val);
        },
      };

      const auditEvents: AuditTelemetryEvent[] = [];
      let handlerReceivedInput: unknown;

      const guardrails = createGuardrails({
        defaultPolicy: 'auto',
        auditStorage,
        redactPII: {
          enabled: true,
          sensitiveKeys: ['iban'],
          customPatterns: [
            {
              name: 'internal_id',
              pattern: /EMP-\d{4}/g,
              replacement: '[REDACTED_EMP_ID]',
            },
          ],
        },
        onAudit: (event) => {
          auditEvents.push(event);
        },
      }).register('submit_kyc_profile', {
        description: 'Submit KYC profile with sensitive fields',
        inputSchema: z.object({
          contactNote: z.string(),
          authHeader: z.string(),
          jwt: z.string(),
          apiKey: z.string(),
          iban: z.string(),
        }),
        policy: 'auto',
        handler: (input) => {
          handlerReceivedInput = input;
          return {
            status: 'VERIFIED',
            confirmationSentTo: 'alice.smith@example.com',
          };
        },
      });

      const rawPayload = {
        contactNote:
          'Email alice.smith@example.com, call +1-555-234-5678, SSN 123-45-6789, card 4111 2222 3333 4444, ref EMP-9021',
        authHeader: 'Bearer sk_live_secret_token_998877',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        apiKey: 'super_secret_key_value',
        iban: 'GB29NWBK60161331926819',
      };

      const res = await guardrails.execute('submit_kyc_profile', rawPayload);
      expect(res.success).toBe(true);

      // 1) Handler receives unmutated validated input
      expect(handlerReceivedInput).toEqual(rawPayload);

      // 2) onAudit telemetry receives redacted arguments and output
      expect(auditEvents).toHaveLength(1);
      const auditedArgs = auditEvents[0]?.arguments as Record<string, string>;
      expect(auditedArgs.contactNote).toContain('[REDACTED_EMAIL]');
      expect(auditedArgs.contactNote).toContain('[REDACTED_PHONE]');
      expect(auditedArgs.contactNote).toContain('[REDACTED_SSN]');
      expect(auditedArgs.contactNote).toContain('[REDACTED_CARD]');
      expect(auditedArgs.contactNote).toContain('[REDACTED_EMP_ID]');
      expect(auditedArgs.contactNote).not.toContain('alice.smith@example.com');
      expect(auditedArgs.contactNote).not.toContain('123-45-6789');
      expect(auditedArgs.contactNote).not.toContain('4111 2222 3333 4444');
      expect(auditedArgs.authHeader).toBe('[REDACTED_TOKEN]');
      expect(auditedArgs.jwt).toBe('[REDACTED_TOKEN]');
      expect(auditedArgs.apiKey).toBe('[REDACTED]');
      expect(auditedArgs.iban).toBe('[REDACTED]');

      // 3) Persistent AuditStorageAdapter also stores redacted entries
      const persistedRaw = memoryStore.get(
        '@react-native-agent-guard/audit-log',
      );
      expect(persistedRaw).toBeDefined();
      expect(persistedRaw).not.toContain('alice.smith@example.com');
      expect(persistedRaw).not.toContain('super_secret_key_value');
      expect(persistedRaw).not.toContain('GB29NWBK60161331926819');
    });
  });
});
