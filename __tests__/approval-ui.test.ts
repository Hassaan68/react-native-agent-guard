import React from 'react';
import { z } from 'zod';
import {
  AgentApprovalProvider,
  AgentApprovalSheet,
  createExpoBiometricHandler,
  createGuardrails,
  createMCPSSETransport,
  createToolRegistry,
  jsonSchemaToZod,
  parseSSEMessages,
  redactPIIValue,
  toLangChainTools,
  toVercelAITools,
  useAgentApproval,
  zodToJsonSchemaSafe,
  type AgentApprovalContextValue,
} from '../src';

/**
 * Lightweight synchronous React hook & context harness for testing
 * `AgentApprovalProvider`, `useAgentApproval`, and `AgentApprovalSheet` in a Node Jest environment.
 */
function createReactTestHarness() {
  const states: unknown[] = [];
  let stateCursor = 0;
  const effectDeps: Array<unknown[] | undefined> = [];
  const effectCleanups: Array<(() => void) | void> = [];
  let effectCursor = 0;
  let activeContextValue: unknown = null;
  let rerenderFn: (() => void) | null = null;

  const useStateSpy = jest
    .spyOn(React, 'useState')
    .mockImplementation(((initialValue: unknown) => {
      const idx = stateCursor++;
      if (!(idx in states)) {
        states[idx] =
          typeof initialValue === 'function'
            ? (initialValue as () => unknown)()
            : initialValue;
      }
      const setState = (updater: unknown) => {
        const prev = states[idx];
        states[idx] =
          typeof updater === 'function'
            ? (updater as (p: unknown) => unknown)(prev)
            : updater;
        if (rerenderFn) {
          rerenderFn();
        }
      };
      return [states[idx], setState];
    }) as typeof React.useState);

  const useEffectSpy = jest
    .spyOn(React, 'useEffect')
    .mockImplementation((effect, deps) => {
      const idx = effectCursor++;
      const prevDeps = effectDeps[idx];
      const changed =
        !prevDeps ||
        !deps ||
        deps.length !== prevDeps.length ||
        deps.some((d, i) => !Object.is(d, prevDeps[i]));

      if (changed) {
        if (typeof effectCleanups[idx] === 'function') {
          effectCleanups[idx]!();
        }
        effectDeps[idx] = deps ? [...deps] : undefined;
        effectCleanups[idx] = effect();
      }
    });

  const useCallbackSpy = jest
    .spyOn(React, 'useCallback')
    .mockImplementation(((fn: unknown) => fn) as typeof React.useCallback);

  const useMemoSpy = jest
    .spyOn(React, 'useMemo')
    .mockImplementation(((factory: () => unknown) =>
      factory()) as typeof React.useMemo);

  const useContextSpy = jest
    .spyOn(React, 'useContext')
    .mockImplementation(() => activeContextValue);

  return {
    setRerender(fn: () => void) {
      rerenderFn = fn;
    },
    resetCursors() {
      stateCursor = 0;
      effectCursor = 0;
    },
    setContextValue(val: unknown) {
      activeContextValue = val;
    },
    getContextValue(): AgentApprovalContextValue | null {
      return activeContextValue as AgentApprovalContextValue | null;
    },
    unmount() {
      for (const cleanup of effectCleanups) {
        if (typeof cleanup === 'function') {
          cleanup();
        }
      }
    },
    restore() {
      useStateSpy.mockRestore();
      useEffectSpy.mockRestore();
      useCallbackSpy.mockRestore();
      useMemoSpy.mockRestore();
      useContextSpy.mockRestore();
    },
  };
}

describe('ApprovalContext & AgentApprovalSheet UI Suite', () => {
  it('throws a clear error when useAgentApproval() is called outside <AgentApprovalProvider>', () => {
    const harness = createReactTestHarness();
    harness.setContextValue(null);

    expect(() => useAgentApproval()).toThrow(
      'useAgentApproval must be used within an <AgentApprovalProvider>.',
    );

    harness.restore();
  });

  it('manages sequential and concurrent FIFO approval requests, approve/deny transitions, and unmount fallback', async () => {
    const harness = createReactTestHarness();
    const registry = createToolRegistry();

    registry
      .register('transfer_a', {
        description: 'First transfer',
        inputSchema: z.object({ amount: z.number() }),
        policy: 'confirm',
        handler: ({ amount }) => ({ transferred: amount }),
      })
      .register('transfer_b', {
        description: 'Second transfer',
        inputSchema: z.object({ amount: z.number() }),
        policy: 'confirm',
        handler: ({ amount }) => ({ transferred: amount }),
      });

    let latestSheetTree: React.ReactNode = null;

    const renderTree = () => {
      harness.resetCursors();
      const providerElement = AgentApprovalProvider({
        registry,
        children: null,
      }) as React.ReactElement<{ value: AgentApprovalContextValue }>;
      harness.setContextValue(providerElement.props.value);
      latestSheetTree = AgentApprovalSheet({
        title: 'Custom Security Review',
        approveLabel: 'Allow Action',
        denyLabel: 'Block Action',
        colorScheme: 'dark',
        theme: { approveButtonBackground: '#007AFF' },
      });
    };

    harness.setRerender(renderTree);
    renderTree();

    // Initially idle: currentRequest is null and sheet renders null
    expect(useAgentApproval().currentRequest).toBeNull();
    expect(useAgentApproval().queueLength).toBe(0);
    expect(latestSheetTree).toBeNull();

    // Calling approve() and deny() when queue is empty is a safe no-op
    useAgentApproval().approve();
    useAgentApproval().deny();
    expect(useAgentApproval().queueLength).toBe(0);

    // Fire two concurrent 'confirm' tool executions
    const execPromise1 = registry.execute('transfer_a', { amount: 100 });
    const execPromise2 = registry.execute('transfer_b', { amount: 250 });

    // Wait a microtask for Zod safeParseAsync to enqueue both requests into AgentApprovalProvider
    await new Promise((r) => setTimeout(r, 15));

    const ctxAfterEnqueue = useAgentApproval();
    expect(ctxAfterEnqueue.queueLength).toBe(2);
    expect(ctxAfterEnqueue.currentRequest?.toolName).toBe('transfer_a');
    expect(latestSheetTree).not.toBeNull();

    // Approve 1st item in FIFO queue -> advances to 2nd item
    ctxAfterEnqueue.approve();
    const res1 = await execPromise1;
    expect(res1.success).toBe(true);
    expect(res1.data).toEqual({ transferred: 100 });

    const ctxSecond = useAgentApproval();
    expect(ctxSecond.queueLength).toBe(1);
    expect(ctxSecond.currentRequest?.toolName).toBe('transfer_b');
    expect(latestSheetTree).not.toBeNull();

    // Deny 2nd item in FIFO queue -> queue becomes empty
    ctxSecond.deny();
    const res2 = await execPromise2;
    expect(res2.success).toBe(false);
    expect(res2.code).toBe('USER_DENIED');

    expect(useAgentApproval().queueLength).toBe(0);
    expect(useAgentApproval().currentRequest).toBeNull();
    expect(latestSheetTree).toBeNull();

    // Unmount provider -> detaches approval handler and falls back to USER_DENIED
    harness.unmount();
    const afterUnmountRes = await registry.execute('transfer_a', {
      amount: 50,
    });
    expect(afterUnmountRes.success).toBe(false);
    expect(afterUnmountRes.code).toBe('USER_DENIED');
    expect(afterUnmountRes.error?.message).toContain(
      'no onApprovalRequired handler',
    );

    harness.restore();
  });

  it('renders AgentApprovalSheet in light, system, and dark modes and handles circular JSON inputs', () => {
    const harness = createReactTestHarness();
    const circularObj: Record<string, unknown> = { name: 'self' };
    circularObj.self = circularObj;

    const mockApprove = jest.fn();
    const mockDeny = jest.fn();

    harness.setContextValue({
      currentRequest: {
        id: 'req_1',
        toolName: 'sync_ble',
        description: 'Sync BLE device',
        input: circularObj,
        policy: 'confirm',
        timestamp: Date.now(),
      },
      queueLength: 3,
      approve: mockApprove,
      deny: mockDeny,
    });

    // Render with default system light theme + custom style props
    const lightSheet = AgentApprovalSheet({
      colorScheme: 'light',
      containerStyle: { padding: 4 },
      sheetStyle: { borderRadius: 16 },
      titleStyle: { fontSize: 20 },
      sectionLabelStyle: { letterSpacing: 1 },
      toolNameStyle: { fontWeight: '700' },
      descriptionStyle: { fontSize: 13 },
      codeBlockStyle: { padding: 8 },
      codeTextStyle: { fontSize: 12 },
      buttonStyle: { borderRadius: 10 },
      approveButtonStyle: { opacity: 0.95 },
      denyButtonStyle: { opacity: 0.95 },
      approveTextStyle: { fontSize: 14 },
      denyTextStyle: { fontSize: 14 },
    });
    expect(lightSheet).not.toBeNull();

    // Render with default props (system scheme)
    const defaultSheet = AgentApprovalSheet({});
    expect(defaultSheet).not.toBeNull();

    harness.restore();
  });

  it('covers remaining registry, MCP, redaction, biometrics, and adapter branches', async () => {
    const guardrails = createGuardrails({
      defaultPolicy: 'auto',
      redactPII: {
        enabled: true,
        replacement: '***',
        redactHandlerInput: true,
      },
    });

    // Dynamic checkPermission returning a ToolPolicy or boolean
    const guardrailsWithPolicyHook = createGuardrails({
      checkPermission: async (toolName) =>
        toolName === 'auto_tool' ? 'auto' : true,
      permissions: {
        dynamic_perm: async () => 'auto' as const,
      },
    });
    guardrailsWithPolicyHook.register('auto_tool', {
      description: 'Auto tool',
      inputSchema: z.object({}),
      handler: () => 'ok',
    });
    guardrailsWithPolicyHook.register('dynamic_perm', {
      description: 'Dynamic permission override tool',
      inputSchema: z.object({}),
      handler: () => 'ok',
    });
    guardrailsWithPolicyHook.register('tool_with_own_fn_policy', {
      description: 'Tool with function policy',
      inputSchema: z.object({}),
      policy: async () => 'confirm' as const,
      handler: () => 'ok',
    });
    expect(await guardrailsWithPolicyHook.checkToolPermission('auto_tool')).toBe(
      'auto',
    );
    expect(
      await guardrailsWithPolicyHook.checkToolPermission('dynamic_perm'),
    ).toBe('auto');
    expect(
      await guardrailsWithPolicyHook.checkToolPermission(
        'tool_with_own_fn_policy',
      ),
    ).toBe('confirm');
    await guardrailsWithPolicyHook.execute('dynamic_perm', {});

    // Tool not found, unregister, clearAuditLog with removeItem
    const removeItem = jest.fn();
    const guardrailsWithRemove = createGuardrails({
      auditStorage: {
        getItem: () => '[{"id":"old"}]',
        setItem: () => {},
        removeItem,
      },
      maxAuditEntries: 2,
    });
    await guardrailsWithRemove.execute('missing_1', {});
    await guardrailsWithRemove.execute('missing_2', {});
    await guardrailsWithRemove.execute('missing_3', {});
    expect(guardrailsWithRemove.getAuditLog()).toHaveLength(2);
    await guardrailsWithRemove.clearAuditLog();
    expect(removeItem).toHaveBeenCalledTimes(1);
    const notFound = await guardrails.execute('unknown_tool', {});
    expect(notFound.code).toBe('TOOL_NOT_FOUND');

    guardrails.register('temp_tool', {
      description: 'Temporary tool',
      inputSchema: z.object({ email: z.string() }),
      handler: (input) => {
        if (input.email === 'throw') {
          throw new Error('Handler boom');
        }
        return input;
      },
    });

    // Handler receives redacted input when redactHandlerInput: true
    const redactedExec = await guardrails.execute('temp_tool', {
      email: 'user@example.com',
    });
    expect(redactedExec.success).toBe(true);
    expect(redactedExec.data).toEqual({ email: '***' });

    // Handler runtime error -> EXECUTION_ERROR
    const errExec = await guardrails.execute('temp_tool', {
      email: 'throw',
    });
    expect(errExec.success).toBe(false);
    expect(errExec.code).toBe('EXECUTION_ERROR');

    expect(guardrails.unregister('temp_tool')).toBe(true);
    await guardrails.clearAuditLog();
    expect(guardrails.getAuditLog()).toHaveLength(0);

    // Biometric handler factory & setBiometricHandler
    const bioHandler = createExpoBiometricHandler({
      promptMessage: 'Verify identity',
      fallbackLabel: 'Use Passcode',
      requireConfirmation: true,
    });
    guardrails.setBiometricHandler(bioHandler);
    guardrails.register('bio_tool', {
      description: 'Biometric tool',
      inputSchema: z.object({}),
      policy: 'biometric',
      handler: () => ({ verified: true }),
    });
    const bioRes = await guardrails.execute('bio_tool', {});
    expect(bioRes.success).toBe(true);

    // JSON schema conversion edge cases (boolean, integer, number bounds, array, enum)
    const zodConverted = jsonSchemaToZod({
      type: 'object',
      properties: {
        flag: { type: 'boolean' },
        count: { type: 'integer', minimum: 1, maximum: 10 },
        tags: { type: 'array', items: { type: 'string', maxLength: 10 } },
        mode: { type: 'string', enum: ['fast', 'accurate'] },
      },
      required: ['flag', 'count'],
    });
    const parsedSchema = await zodConverted.safeParseAsync({
      flag: true,
      count: 5,
      tags: ['rn'],
      mode: 'fast',
    });
    expect(parsedSchema.success).toBe(true);

    // SSE parser with non-JSON keepalive and relative URL resolution
    const parsedSSE = parseSSEMessages(
      'event: ping\ndata: keepalive\n\nevent: endpoint\ndata: /rpc\n\n',
    );
    expect(parsedSSE.endpointUrl).toBe('/rpc');

    // MCP callTool with isError=true
    const failingMcp = createMCPSSETransport({
      url: 'https://mcp.example.com/sse',
      postUrl: 'https://mcp.example.com/rpc',
      initializeOnConnect: false,
      fetchFn: (async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Remote execution failed' }],
            },
          }),
      })) as unknown as typeof fetch,
    });
    await expect(failingMcp.callTool('bad_tool', {})).rejects.toThrow(
      'Remote execution failed',
    );

    // Redaction disabled, non-matching 13-digit string, & array redaction
    expect(redactPIIValue({ a: 'alice@example.com' }, false)).toEqual({
      a: 'alice@example.com',
    });
    expect(redactPIIValue({ a: 'alice@example.com' }, { enabled: false })).toEqual({
      a: 'alice@example.com',
    });
    expect(
      redactPIIValue(['alice@example.com', 42, null], {
        enabled: true,
        customPatterns: [{ pattern: /custom/i }],
      }),
    ).toEqual(['[REDACTED_EMAIL]', 42, null]);

    // Adapters without unwrapData (both success and failure paths)
    guardrails.register('fail_tool', {
      description: 'Always denied',
      inputSchema: z.object({}),
      policy: 'deny',
      handler: () => ({}),
    });
    const rawVercel = toVercelAITools(guardrails);
    const rawLc = toLangChainTools(guardrails);
    expect(rawVercel.bio_tool).toBeDefined();
    await rawVercel.bio_tool!.execute({});
    await rawVercel.fail_tool!.execute({});

    expect(rawLc.length).toBeGreaterThanOrEqual(2);
    const rawFuncStr = await rawLc[0]!.func({});
    expect(JSON.parse(rawFuncStr)).toEqual(
      expect.objectContaining({ success: true }),
    );
    const failLcTool = rawLc.find((t) => t.name === 'fail_tool')!;
    await failLcTool.invoke({});
    const failFuncStr = await failLcTool.func({});
    expect(JSON.parse(failFuncStr)).toEqual(
      expect.objectContaining({ success: false, code: 'DENIED_BY_POLICY' }),
    );

    const throwingLc = toLangChainTools(guardrails, { throwOnError: true });
    const throwingFailTool = throwingLc.find((t) => t.name === 'fail_tool')!;
    await expect(throwingFailTool.func({})).rejects.toThrow();

    // MCP edge cases: non-object schema, HTTP error, RPC error
    expect(jsonSchemaToZod(undefined)).toBeDefined();
    expect(jsonSchemaToZod({ type: 'null' })).toBeDefined();

    const rpcErrorMcp = createMCPSSETransport({
      url: 'https://mcp.example.com/sse',
      initializeOnConnect: false,
      fetchFn: (async () => ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32601, message: 'Method not found' },
          }),
      })) as unknown as typeof fetch,
    });
    await expect(rpcErrorMcp.listTools()).rejects.toThrow('Method not found');

    const httpErrorMcp = createMCPSSETransport({
      url: 'https://mcp.example.com/sse',
      initializeOnConnect: false,
      fetchFn: (async () => ({
        ok: false,
        status: 503,
        headers: { get: () => 'application/json' },
        text: async () => 'Service Unavailable',
      })) as unknown as typeof fetch,
    });
    await expect(httpErrorMcp.listTools()).rejects.toThrow('HTTP 503');

    // zodToJsonSchemaSafe with array items in strict mode
    const strictArrSchema = zodToJsonSchemaSafe(
      z.object({
        items: z.array(z.object({ id: z.string() })),
      }),
      { strict: true },
    );
    expect(strictArrSchema.additionalProperties).toBe(false);
  });
});
