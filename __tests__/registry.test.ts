import React from 'react';
import { z } from 'zod';
import {
  AgentApprovalProvider,
  AgentApprovalSheet,
  createBleSyncToolPreset,
  createCalendarEventToolPreset,
  createPaymentToolPreset,
  createToolRegistry,
  type AuditStorageAdapter,
} from '../src';

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
});
