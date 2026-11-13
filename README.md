# react-native-agent-guard

[![CI](https://github.com/Hassaan68/react-native-agent-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/Hassaan68/react-native-agent-guard/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/react-native-agent-guard.svg?style=flat-square)](https://www.npmjs.com/package/react-native-agent-guard)
[![Try it on Expo Snack](https://img.shields.io/badge/Expo_Snack-Try_Live_Demo-000020?style=flat-square&logo=expo&logoColor=white)](https://snack.expo.dev/@hassaan68/react-native-agent-guard-demo)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square)](./LICENSE)
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

> **Peer Dependencies**: Ensure `react` (`>=18.0.0`), `react-native` (`>=0.72.0`), and `zod` (`^4.0.0`) are installed in your React Native project. For native hardware biometrics (`policy: 'biometric'`), install `expo-local-authentication`.

---

## Live Interactive Playground (Expo Snack)

Want to test `react-native-agent-guard` (`v0.3.2`) directly in your browser or on your phone via **Expo Go** in under 30 seconds?

👉 **[Launch the Live Expo Snack Demo (`@hassaan68/react-native-agent-guard-demo`)](https://snack.expo.dev/@hassaan68/react-native-agent-guard-demo)**

Or copy the source files directly from this repository:
1. Open **[https://snack.expo.dev/@hassaan68/react-native-agent-guard-demo](https://snack.expo.dev/@hassaan68/react-native-agent-guard-demo)**.
2. Inspect the dependencies in **[`examples/expo-snack/package.json`](./examples/expo-snack/package.json)** (`react-native-agent-guard@0.3.2`, `zod`, `expo-local-authentication`).
3. View or customize the single-file interactive dashboard in **[`examples/expo-snack/App.js`](./examples/expo-snack/App.js)**.

The Snack playground lets you interactively test:
- **Dynamic Policy Routing**: `< $50` (`'auto'`), `$50–$199` (`<AgentApprovalSheet />`), and `$200+` (`'biometric'` with web/simulator fallback).
- **Agent Loop Protection**: Spam-clicking an `'auto'` tool to trigger automatic policy escalation to `'confirm'` after `maxCallsPerMinute` is exceeded.
- **Live PII Redaction**: Inspecting real-time `onAudit` telemetry with automatic masking of emails, credit cards, SSNs, phone numbers, and Bearer tokens.
- **Vercel AI SDK & OpenAI Strict Exports**: Viewing generated `toVercelAITools()` and `toOpenAITools({ strict: true })` schemas.

---

## Biometric Authentication Setup (`policy: 'biometric'`)

When a tool's policy resolves to `'biometric'`, `react-native-agent-guard` automatically triggers a native FaceID / TouchID / Android Biometric prompt via `expo-local-authentication` before executing the tool handler.

### Option A: Expo Projects

1. Install `expo-local-authentication`:

   ```bash
   npx expo install expo-local-authentication
   ```

2. Configure the FaceID usage description plugin in your `app.json` / `app.config.js`:

   ```json
   {
     "expo": {
       "plugins": [
         [
           "expo-local-authentication",
           {
             "faceIDPermission": "Allow $(PRODUCT_NAME) to verify your identity before executing sensitive AI agent actions."
           }
         ]
       ]
     }
   }
   ```

### Option B: Bare React Native CLI Projects

1. Install `expo-local-authentication` (with Expo modules configured via `npx install-expo-modules@latest`):

   ```bash
   npm install expo-local-authentication
   cd ios && pod install
   ```

2. Add native platform permissions:

   - **iOS (`ios/<AppName>/Info.plist`)**:
     ```xml
     <key>NSFaceIDUsageDescription</key>
     <string>Verify your identity before executing sensitive AI agent actions.</string>
     ```
   - **Android (`android/app/src/main/AndroidManifest.xml`)**:
     ```xml
     <uses-permission android:name="android.permission.USE_BIOMETRIC" />
     <uses-permission android:name="android.permission.USE_FINGERPRINT" />
     ```

   > **Using `react-native-biometrics` instead**: If your bare React Native project uses `react-native-biometrics` or a custom hardware keychain, pass an `onBiometricRequired` callback to `createGuardrails({ onBiometricRequired: async (req) => { ... } })`.

---

## Quick Start

### 1. Configure Guardrails (`createGuardrails`)

Use `createGuardrails()` to configure a `defaultPolicy`, per-tool `permissions`, `blockedTools`, and a custom `checkPermission` hook:

```ts
import { z } from 'zod';
import { createGuardrails } from 'react-native-agent-guard';

export const guardrails = createGuardrails({
  defaultPolicy: 'confirm',
  blockedTools: ['wipe_device_storage'],
  permissions: {
    get_battery_level: 'auto',
  },
  // Custom permission check evaluated before tool execution
  checkPermission: async (toolName, parsedInput) => {
    if (
      toolName === 'send_payment' &&
      typeof parsedInput === 'object' &&
      parsedInput !== null &&
      'amount' in parsedInput
    ) {
      const amount = Number((parsedInput as { amount: number }).amount);
      if (amount > 1000) return 'deny';
      if (amount > 100) return 'biometric';
      if (amount > 25) return 'confirm';
      return 'auto';
    }
    return true; // Fall back to per-tool policy or defaultPolicy ('confirm')
  },
});

// Inspect effective policy for any tool & input before execution
const policy = await guardrails.checkToolPermission('send_payment', {
  recipient: 'alice@example.com',
  amount: 250,
}); // -> 'biometric'
```

---

## Agent Loop Protection & Rate Limiting (`rateLimit`)

Prevent runaway agent loops, hallucinated retry storms, and quota exhaustion by configuring `rateLimit` at either the global `createGuardrails()` level or per tool. When a tool exceeds `maxCallsPerMinute` or `maxSessionCalls`, `react-native-agent-guard` can either block execution with a `RATE_LIMITED` error (including self-correction `llmFeedback` telling the model to stop retrying) or dynamically escalate the policy from `'auto'` to `'confirm'` or `'biometric'`:

```ts
import { z } from 'zod';
import { createGuardrails } from 'react-native-agent-guard';

const guardrails = createGuardrails({
  defaultPolicy: 'auto',
  // Global fallback rate limit across tools
  rateLimit: {
    maxCallsPerMinute: 10,
    maxSessionCalls: 50,
    onLimitExceeded: 'deny', // Returns code: 'RATE_LIMITED' with self-correcting llmFeedback
  },
}).register('send_sms', {
  description: 'Send an SMS notification to a contact',
  inputSchema: z.object({
    to: z.string(),
    message: z.string().max(160),
  }),
  policy: 'auto',
  // Per-tool rate limit: allow 2 automatic SMS calls per minute, then escalate to user confirmation!
  rateLimit: {
    maxCallsPerMinute: 2,
    maxSessionCalls: 5,
    onLimitExceeded: 'confirm', // 'deny' | 'confirm' | 'biometric'
  },
  handler: async ({ to, message }) => ({ deliveredTo: to, message }),
});

// Reset counters for a specific tool (or omit argument to reset all tools)
guardrails.resetRateLimits('send_sms');
```

---

## Built-In PII Redaction & Argument Sanitization (`redactPII`)

Automatically scrub Personally Identifiable Information (PII) and credentials from `onAudit` / `onExecution` telemetry payloads, in-memory `getAuditLog()` entries, and persistent `AuditStorageAdapter` (`AsyncStorage` / `MMKV`) logs **without mutating the validated arguments passed to your tool handler**:

- **Built-in Pattern Masking**: Emails (`[REDACTED_EMAIL]`), Phone Numbers (`[REDACTED_PHONE]`), Credit Cards (`[REDACTED_CARD]`), SSNs (`[REDACTED_SSN]`), and JWT / Bearer Tokens (`[REDACTED_TOKEN]`).
- **Sensitive Key Masking**: Automatically masks object fields named `password`, `secret`, `token`, `apiKey`, `authorization`, `ssn`, `cvv`, `pin`, `privateKey`, `cardNumber`, plus any custom `sensitiveKeys`.

```ts
import { createGuardrails, redactPIIValue } from 'react-native-agent-guard';

const guardrails = createGuardrails({
  defaultPolicy: 'confirm',
  redactPII: {
    enabled: true,
    sensitiveKeys: ['iban', 'routingNumber'],
    customPatterns: [
      {
        name: 'account_id',
        pattern: /ACC-\d{6}/g,
        replacement: '[REDACTED_ACC]',
      },
    ],
  },
  onAudit: (event) => {
    // event.arguments and event.output are automatically redacted before reaching your telemetry backend!
    console.log('Sanitized audit payload:', event.arguments);
  },
});

// You can also use redactPIIValue() standalone anywhere in your app:
const clean = redactPIIValue({
  note: 'Contact alice@example.com or +1-555-234-5678',
  apiKey: 'sk_live_12345',
});
// -> { note: 'Contact [REDACTED_EMAIL] or [REDACTED_PHONE]', apiKey: '[REDACTED]' }
```

### 2. Register Tools & Connect React Native Approval UI

```tsx
import React from 'react';
import { Button, SafeAreaView } from 'react-native';
import { z } from 'zod';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  createGuardrails,
  AgentApprovalProvider,
  AgentApprovalSheet,
} from 'react-native-agent-guard';

// 1. Initialize guardrails with defaultPolicy, checkPermission, and biometric verification
export const registry = createGuardrails({
  defaultPolicy: 'confirm',
  defaultTimeoutMs: 15_000,
  checkPermission: (toolName, parsedInput) => {
    if (toolName === 'delete_account_data') return 'confirm';
    return true;
  },
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

## Exporting Strict Schemas for OpenAI, Claude, and MCP (`.transform()` & `.refine()` Safe)

Define complex tool schemas using Zod v4's `.transform()`, `.refine()`, and `.superRefine()` without worrying about JSON Schema serialization failures. `react-native-agent-guard` automatically extracts the LLM input contract (`io: 'input'`) during schema export while running full `.refine()` checks and `.transform()` pipelines at execution time:

```ts
import { z } from 'zod';
import {
  createGuardrails,
  zodToOpenAISchema,
  zodToClaudeSchema,
} from 'react-native-agent-guard';

const guardrails = createGuardrails();

guardrails.register('send_payment', {
  description: 'Send a peer-to-peer payment with normalized inputs',
  inputSchema: z
    .object({
      recipient: z
        .string()
        .min(1)
        .transform((val) => val.trim().toLowerCase()),
      amount: z
        .number()
        .positive()
        .refine((n) => n <= 10_000, 'Transfer cannot exceed $10,000'),
      currency: z
        .string()
        .length(3)
        .default('usd')
        .transform((c) => c.toUpperCase()),
    })
    .refine((data) => data.recipient !== 'sanctioned@example.com', {
      message: 'Recipient is restricted',
      path: ['recipient'],
    }),
  policy: 'confirm',
  handler: async (parsed) => {
    // parsed.recipient is trimmed & lowercased; parsed.currency is uppercased!
    return { status: 'SENT', ...parsed };
  },
});

// 1. OpenAI Function Calling (with Strict Structured Outputs enabled)
const openAITools = guardrails.toOpenAITools({ strict: true });
/*
[
  {
    type: 'function',
    function: {
      name: 'send_payment',
      description: 'Send a peer-to-peer payment with normalized inputs',
      strict: true,
      parameters: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        additionalProperties: false,
        properties: { ... },
        required: ['recipient', 'amount']
      }
    }
  }
]
*/

// 2. Anthropic Claude Messages API
const claudeTools = guardrails.toClaudeTools({ strict: true });
/*
[
  {
    name: 'send_payment',
    description: 'Send a peer-to-peer payment with normalized inputs',
    input_schema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', ... }
  }
]
*/

// 3. Model Context Protocol (MCP)
const mcpTools = guardrails.toMCPTools();
```

---

## Framework Integrations (Vercel AI SDK & LangChain)

Convert your `GuardrailRegistry` tools directly into executable tool definitions for the **Vercel AI SDK** (`ai`) and **LangChain.js** (`@langchain/core/tools`). Every tool invocation triggered by the framework automatically routes through your guardrail policy engine, `<AgentApprovalSheet />`, hardware biometrics (`expo-local-authentication`), and `onAudit` telemetry.

### 1. Vercel AI SDK (`toVercelAITools`)

```ts
import { generateText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { createGuardrails } from 'react-native-agent-guard';
import { z } from 'zod';

const guardrails = createGuardrails({ defaultPolicy: 'confirm' }).register(
  'send_payment',
  {
    description: 'Send a peer-to-peer payment',
    inputSchema: z.object({
      recipient: z.string(),
      amount: z.number().positive(),
    }),
    policy: ({ amount }) => (amount <= 50 ? 'auto' : 'biometric'),
    handler: async ({ recipient, amount }) => ({
      txId: `tx_${Date.now()}`,
      recipient,
      amount,
    }),
  },
);

// Convert registered tools into Vercel AI SDK format
const tools = guardrails.toVercelAITools({ unwrapData: true });

const { text, toolResults } = await generateText({
  model: openai('gpt-4o'),
  tools,
  maxSteps: 3,
  prompt: 'Send $120 to alice@example.com',
});
```

### 2. LangChain.js (`toLangChainTools`)

```ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import { ChatAnthropic } from '@langchain/anthropic';
import { createGuardrails, toLangChainTools } from 'react-native-agent-guard';

const guardrails = createGuardrails({ defaultPolicy: 'confirm' });
// ...register tools on `guardrails`

// Option A: Pass directly to DynamicStructuredTool
const langChainDefs = toLangChainTools(guardrails, { unwrapData: true });
const structuredTools = langChainDefs.map(
  (def) =>
    new DynamicStructuredTool({
      name: def.name,
      description: def.description,
      schema: def.schema,
      func: def.func,
    }),
);

// Option B: Or invoke directly via Runnable-compatible `.invoke()`
const result = await langChainDefs[0].invoke({
  recipient: 'bob@example.com',
  amount: 40,
});
```

---

## Model Context Protocol (MCP) SSE Transport Adapter

Connect your mobile agent directly to remote SSE-based **Model Context Protocol (MCP)** servers. `react-native-agent-guard` automatically performs the MCP `initialize` handshake, discovers remote tools via `tools/list`, converts their JSON Schemas (`draft-07`) into runtime Zod v4 validators, and registers them dynamically into `GuardrailRegistry` with full policy enforcement (`'auto' | 'confirm' | 'biometric' | 'deny'`).

### 1. One-Line Connection via `guardrails.connectMCP()`

```ts
import { createGuardrails } from 'react-native-agent-guard';

const guardrails = createGuardrails({
  defaultPolicy: 'confirm',
});

// Connect to a remote MCP SSE server and auto-register all discovered tools
const { transport, tools } = await guardrails.connectMCP({
  url: 'https://mcp.your-server.com/sse',
  headers: {
    Authorization: 'Bearer YOUR_API_TOKEN',
  },
  defaultPolicy: 'confirm', // Require user confirmation by default for remote tools
  toolPolicies: {
    // Override policies for specific remote MCP tools
    list_repositories: 'auto',
    delete_repository: 'biometric',
  },
  timeoutMs: 15_000,
});

console.log(
  'Registered remote MCP tools:',
  tools.map((t) => t.name),
);

// Execute any discovered MCP tool safely through the guardrail pipeline
const result = await guardrails.execute('delete_repository', {
  repo: 'org/legacy-service',
});

// Disconnect when finished
transport.disconnect();
```

### 2. Standalone `createMCPSSETransport()` Adapter

For granular control over the MCP lifecycle (inspecting tools before registering or calling `callTool` directly):

```ts
import {
  createGuardrails,
  createMCPSSETransport,
} from 'react-native-agent-guard';

const guardrails = createGuardrails();

const mcpTransport = createMCPSSETransport({
  url: 'https://mcp.your-server.com/sse',
  toolPrefix: 'github_', // Optional prefix -> e.g. 'github_create_issue'
  defaultPolicy: 'confirm',
});

await mcpTransport.connect();

// Inspect available remote tools
const remoteTools = await mcpTransport.listTools();

// Register them dynamically into GuardrailRegistry
await mcpTransport.registerTools(guardrails);
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

## Audit Telemetry & Persistent Logging (`onAudit` / `onExecution`)

Every tool execution lifecycle event—including `auto` executions, user modal approvals/rejections (`confirm`), hardware biometric outcomes (`biometric`), policy blocks (`deny`), validation failures, and runtime timeouts—automatically emits a structured [`AuditTelemetryEvent`](./src/types.ts) to your `onAudit` or `onExecution` hooks.

### Telemetry Payload Shape

| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | `string` | Unique audit event identifier |
| `timestamp` | `number` | Unix epoch timestamp (ms) when execution started |
| `isoTimestamp` | `string` | ISO-8601 formatted timestamp string |
| `toolName` | `string` | Name of the invoked tool |
| `arguments` | `unknown` | Validated tool arguments (`parsedInput` or fallback `rawInput`) |
| `policy` | `'auto' \| 'confirm' \| 'biometric' \| 'deny'` | Resolved guardrail policy |
| `outcome` | `'approved' \| 'denied' \| 'failed'` | High-level governance outcome |
| `status` | `AuditExecutionStatus` | Granular status (`SUCCESS`, `USER_DENIED`, `BIOMETRIC_FAILED`, `DENIED_BY_POLICY`, `VALIDATION_ERROR`, `TIMEOUT_ERROR`, `EXECUTION_ERROR`) |
| `duration` / `durationMs` | `number` | Total execution duration in milliseconds |
| `output` | `unknown` | Tool handler return value (when `outcome === 'approved'`) |
| `errorMessage` | `string` | Detailed error or rejection message (when `outcome !== 'approved'`) |

### Wiring Up Backend Analytics & Local Storage

```ts
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createGuardrails } from 'react-native-agent-guard';

const guardrails = createGuardrails({
  defaultPolicy: 'confirm',
  // 1. Stream real-time governance telemetry to your backend or analytics SDK
  onAudit: async (event) => {
    console.log(
      `[Audit] ${event.isoTimestamp} | ${event.toolName} | policy=${event.policy} | outcome=${event.outcome} (${event.status}) | ${event.duration}ms`,
    );

    // Example: forward structured telemetry to your observability endpoint
    await fetch('https://telemetry.your-app.com/v1/agent-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timestamp: event.timestamp,
        toolName: event.toolName,
        arguments: event.arguments,
        policy: event.policy,
        outcome: event.outcome,
        status: event.status,
        duration: event.duration,
      }),
    });
  },
  // 2. Optionally persist audit history to AsyncStorage or MMKV
  auditStorage: AsyncStorage,
  auditStorageKey: '@my-app/agent-audit-log',
  maxAuditEntries: 500,
});

// 3. Subscribe/unsubscribe dynamically inside React components
const unsubscribe = guardrails.onAudit((event) => {
  if (event.outcome === 'denied') {
    console.warn(`Agent action "${event.toolName}" was blocked:`, event.status);
  }
});

// Inspect in-memory execution history at any time
const history = guardrails.getAuditLog();
```

---

## Security & Threat Modeling

`react-native-agent-guard` is architected with defense-in-depth against **indirect prompt injection, unauthorized tool execution, concurrent modal flooding, and rogue LLM tool calls**.

See **[SECURITY.md](./SECURITY.md)** for our formal mobile agent threat model, trust boundary diagram, defense-in-depth mitigations, and private vulnerability reporting instructions.

---

## Contributing & Local Development

We welcome pull requests, bug reports, and new mobile tool presets! See **[CONTRIBUTING.md](./CONTRIBUTING.md)** for full architectural guidelines.

### Running Checks Locally

```bash
# 1. Install dependencies
pnpm install

# 2. Run linter
pnpm lint

# 3. Run strict TypeScript type-checking (core library + examples/expo-example/App.tsx)
pnpm typecheck

# 4. Run the Jest unit & integration test suite
pnpm test

# 5. Run tests in watch mode during development
pnpm test:watch

# 6. Run tests and generate coverage reports (/coverage)
pnpm test:coverage

# 7. Build CJS, ESM, and TypeScript declaration bundles (/dist)
pnpm build
```

### Automated Releases & npm Provenance

Releases are published automatically via GitHub Actions ([`.github/workflows/release.yml`](./.github/workflows/release.yml)) whenever a new GitHub Release is published. The workflow runs `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` before publishing with cryptographic SLSA build provenance (`npm publish --provenance --access public`) using GitHub OIDC (`id-token: write`) and `secrets.NPM_TOKEN`.

---

## License

Released under the [MIT License](./LICENSE).
