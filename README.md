# react-native-agent-guard

[![npm version](https://img.shields.io/npm/v/react-native-agent-guard.svg?style=flat-square)](https://www.npmjs.com/package/react-native-agent-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
[![CI Status](https://img.shields.io/github/actions/workflow/status/Hassaan68/react-native-agent-guard/ci.yml?branch=main&style=flat-square&label=tests)](https://github.com/Hassaan68/react-native-agent-guard/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6.svg?style=flat-square&logo=typescript&logoColor=white)](./tsconfig.json)

**Zero-dependency permission, policy, validation, and human-in-the-loop guardrails for autonomous AI agents in React Native.**

---

## Why `react-native-agent-guard`?

### The Autonomous Mobile Agent Safety & Execution Gap

As mobile apps embed tool-calling LLMs (OpenAI, Claude, Gemini, on-device models, and MCP clients), agents gain direct access to sensitive native capabilities: **sending payments, mutating calendar events, reading contacts, or writing to Bluetooth Low Energy (BLE) peripherals**.

However, wiring raw LLM tool calls directly into React Native APIs introduces critical failure modes:

1. **Unvalidated & Malformed LLM Inputs**: Models frequently emit stringified JSON or violate parameter constraints, crashing native bridges instead of self-correcting.
2. **No Human-in-the-Loop (HITL) Gateways**: High-stakes actions require interactive modal confirmation or hardware biometrics (`FaceID` / `TouchID`) before native execution—especially when an agent queues multiple tool calls concurrently.
3. **Runaway Promises & Hung Bridges**: Native hardware calls (such as BLE scans or network sockets) can hang indefinitely without race-condition-free timeout boundaries.
4. **Fragmented Tool Schemas**: Maintaining separate tool definitions for OpenAI (`function.parameters`), Anthropic Claude (`input_schema`), and Model Context Protocol (`inputSchema`) creates schema drift.

`react-native-agent-guard` closes this gap in a single, zero-runtime-dependency package powered by **Zod v4**, **React Native**, and **TypeScript**.

---

## Key Features

- **Zero Runtime Dependencies**: Lightweight footprint using `react`, `react-native`, and `zod` (`^4.0.0`) as peer dependencies.
- **Static & Dynamic Execution Policies**: Configure `'auto' | 'confirm' | 'biometric' | 'deny'` statically or compute policies dynamically per invocation (`(parsedInput) => 'auto' | 'confirm' | 'biometric' | 'deny'`).
- **Self-Correcting Zod Validation**: Safely parses stringified JSON and runs `inputSchema.safeParseAsync()`, returning structured `VALIDATION_ERROR` responses with actionable `llmFeedback` strings so agents can self-correct without throwing unhandled exceptions.
- **Headless FIFO Queue & Ready-Made UI**: Use `<AgentApprovalProvider>` + `<AgentApprovalSheet />` out of the box, or build custom approval modals with the `useAgentApproval()` hook.
- **Pluggable Biometrics**: Connect `expo-local-authentication` or `react-native-biometrics` via `onBiometricRequired`.
- **Universal Schema Exporters**: Export registered tools directly to `.toOpenAITools()`, `.toClaudeTools()`, and `.toMCPTools()` using Zod v4's `z.toJSONSchema(schema, { target: 'draft-07' })`.
- **Audit Logging**: Built-in in-memory and persistent `AuditStorageAdapter` (compatible with `AsyncStorage` and `react-native-mmkv`) tracking `durationMs`, policy resolution, and execution status.
- **Built-In Mobile Presets**: Ready-to-use tool factories for payments (`createPaymentToolPreset`), BLE synchronization (`createBleSyncToolPreset`), and calendar events (`createCalendarEventToolPreset`).

---

## Installation

### pnpm

```bash
pnpm add react-native-agent-guard zod
```

### npm

```bash
npm install react-native-agent-guard zod
```

### yarn

```bash
yarn add react-native-agent-guard zod
```

> **Peer Dependencies**: Ensure `react` (`>=18.0.0`), `react-native` (`>=0.72.0`), and `zod` (`^4.0.0`) are installed in your React Native project.

---

## Quickstart

### 1. Create a Tool Registry & Define Policies

```tsx
import React from 'react';
import { Button, SafeAreaView } from 'react-native';
import { z } from 'zod';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  createToolRegistry,
  AgentApprovalProvider,
  AgentApprovalSheet,
} from 'react-native-agent-guard';

// 1. Initialize the registry with biometric verification support
export const registry = createToolRegistry({
  defaultTimeoutMs: 15_000,
  onBiometricRequired: async (request) => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: `Authenticate to run ${request.toolName}`,
    });
    return result.success;
  },
});

// 2. Register tools with Zod v4 schemas and static or dynamic policies
registry
  .register('send_payment', {
    description: 'Send a peer-to-peer payment to a recipient',
    inputSchema: z.object({
      recipient: z.string().min(1),
      amount: z.number().positive(),
      currency: z.enum(['USD', 'EUR', 'GBP']).default('USD'),
    }),
    // Dynamic policy: auto-approve <= $50, require modal confirmation up to $500, and biometrics above $500
    policy: ({ amount }) => {
      if (amount <= 50) return 'auto';
      if (amount <= 500) return 'confirm';
      return 'biometric';
    },
    timeoutMs: 10_000,
    handler: async ({ recipient, amount, currency }) => {
      // Call your native payment SDK or backend API here
      return {
        transactionId: `tx_${Date.now()}`,
        recipient,
        amount,
        currency,
        status: 'COMPLETED',
      };
    },
  })
  .register('delete_account_data', {
    description: 'Delete local cached user data',
    inputSchema: z.object({
      scope: z.enum(['cache', 'preferences']),
    }),
    policy: 'confirm',
    handler: async ({ scope }) => ({ cleared: scope }),
  });

// 3. Wrap your application with <AgentApprovalProvider> and <AgentApprovalSheet />
export default function App() {
  const handleRunAgentTool = async () => {
    // Accepts either a parsed object or stringified JSON directly from an LLM tool call
    const result = await registry.execute(
      'send_payment',
      '{"recipient": "alice@example.com", "amount": 125, "currency": "USD"}',
    );

    if (!result.success) {
      // Pass result.llmFeedback back to the LLM as the tool_result error message
      console.warn('Tool blocked or failed:', result.code, result.llmFeedback);
      return;
    }

    console.log('Payment succeeded in', result.durationMs, 'ms:', result.data);
  };

  return (
    <AgentApprovalProvider registry={registry}>
      <SafeAreaView style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
        <Button title="Simulate Agent Payment ($125)" onPress={handleRunAgentTool} />
        {/* Automatically renders a confirmation sheet whenever a 'confirm' tool is queued */}
        <AgentApprovalSheet />
      </SafeAreaView>
    </AgentApprovalProvider>
  );
}
```

---

## Exporting Schemas for OpenAI, Claude, and MCP

Define your tools once in `ToolRegistry` and export JSON Schema (`draft-07`) definitions for any LLM provider or Model Context Protocol client/server:

```ts
// 1. OpenAI Chat Completions / Responses API
const openAITools = registry.toOpenAITools();
/*
[
  {
    type: 'function',
    function: {
      name: 'send_payment',
      description: 'Send a peer-to-peer payment to a recipient',
      parameters: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', ... }
    }
  }
]
*/

// 2. Anthropic Claude Messages API
const claudeTools = registry.toClaudeTools();
/*
[
  {
    name: 'send_payment',
    description: 'Send a peer-to-peer payment to a recipient',
    input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', ... }
  }
]
*/

// 3. Model Context Protocol (MCP)
const mcpTools = registry.toMCPTools();
/*
[
  {
    name: 'send_payment',
    description: 'Send a peer-to-peer payment to a recipient',
    inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', ... }
  }
]
*/
```

---

## Custom Approval UI with `useAgentApproval()`

If you want full control over your confirmation UI instead of using `<AgentApprovalSheet />`, consume `useAgentApproval()` inside any component wrapped by `<AgentApprovalProvider>`:

```tsx
import React from 'react';
import { View, Text, Button } from 'react-native';
import { useAgentApproval } from 'react-native-agent-guard';

export function CustomApprovalBanner() {
  const { currentRequest, queueLength, approve, deny } = useAgentApproval();

  if (!currentRequest) return null;

  return (
    <View>
      <Text>
        Pending Tool: {currentRequest.toolName} (Queue: {queueLength})
      </Text>
      <Text>{currentRequest.description}</Text>
      <Text>{JSON.stringify(currentRequest.input, null, 2)}</Text>
      <Button title="Approve" onPress={approve} />
      <Button title="Deny" onPress={deny} />
    </View>
  );
}
```

---

## Built-In Mobile Tool Presets

Get started immediately or prototype agent flows with three pre-configured mobile tool presets:

```ts
import {
  createToolRegistry,
  createPaymentToolPreset,
  createBleSyncToolPreset,
  createCalendarEventToolPreset,
} from 'react-native-agent-guard';

const registry = createToolRegistry();

const paymentTool = createPaymentToolPreset({
  autoApproveLimit: 50,
  highValuePolicy: 'biometric',
});

const bleSyncTool = createBleSyncToolPreset({
  timeoutMs: 15_000,
});

const calendarTool = createCalendarEventToolPreset();

registry
  .register(paymentTool.name, paymentTool)
  .register(bleSyncTool.name, bleSyncTool)
  .register(calendarTool.name, calendarTool);
```

---

## Persistent Audit Logging (`AsyncStorage` / `MMKV`)

Pass any storage adapter implementing `{ getItem, setItem, removeItem? }` to persist execution logs across app restarts:

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createToolRegistry } from 'react-native-agent-guard';

const registry = createToolRegistry({
  auditStorage: AsyncStorage,
  auditStorageKey: '@my-app/agent-audit-log',
  maxAuditEntries: 500,
});

// Inspect in-memory execution history at any time
const history = registry.getAuditLog();
```

---

## License

Released under the [MIT License](./LICENSE).
