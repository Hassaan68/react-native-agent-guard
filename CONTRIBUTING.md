# Contributing to `react-native-agent-guard`

Thank you for contributing to `react-native-agent-guard`! We welcome bug reports, feature requests, documentation improvements, new mobile tool presets, and core enhancements.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Architecture Overview](#architecture-overview)
3. [Local Development Setup](#local-development-setup)
4. [Development Workflow & Commands](#development-workflow--commands)
5. [Design & Coding Standards](#design--coding-standards)
6. [Submitting a Pull Request](#submitting-a-pull-request)

---

## Code of Conduct

Please be respectful, constructive, and collaborative in all issues, pull requests, and discussions. We aim to maintain a welcoming environment for React Native and AI engineering contributors of all backgrounds.

---

## Architecture Overview

`react-native-agent-guard` is structured around four focused modules under `src/`:

- **`src/types.ts`**: Public TypeScript interfaces (`ToolPolicy`, `ToolDefinition`, `ApprovalRequest`, `ToolExecutionResult`, `AuditLogEntry`, `AuditStorageAdapter`, and OpenAI/Claude/MCP schema types).
- **`src/registry.ts`**: Core `ToolRegistry` and `createToolRegistry()` implementation handling safe JSON string parsing, async Zod v4 validation (`safeParseAsync`), static and dynamic policy gating (`'auto' | 'confirm' | 'biometric' | 'deny'`), race-condition-free timeouts (`Promise.race` + `clearTimeout`), audit logging, and JSON Schema (`draft-07`) exporters.
- **`src/ApprovalContext.tsx` & `src/AgentApprovalSheet.tsx`**: Headless React FIFO approval queue (`<AgentApprovalProvider>` and `useAgentApproval()`) and zero-dependency React Native confirmation modal (`<AgentApprovalSheet />`).
- **`src/presets.ts`**: Pre-configured mobile tool presets (`createPaymentToolPreset`, `createBleSyncToolPreset`, `createCalendarEventToolPreset`).

---

## Local Development Setup

### Prerequisites

- **Node.js**: `v20.x` LTS or newer
- **Package Manager**: `pnpm` (`v9+`)

### Installation

1. Fork and clone the repository:

   ```bash
   git clone https://github.com/<your-username>/react-native-agent-guard.git
   cd react-native-agent-guard
   ```

2. Install dependencies:

   ```bash
   pnpm install
   ```

---

## Development Workflow & Commands

Before opening a pull request, make sure all verification scripts pass locally:

| Command | Description |
| :--- | :--- |
| `pnpm typecheck` | Runs `tsc --noEmit` in strict mode across `src/` and `__tests__/`. |
| `pnpm test` | Runs the Jest unit test suite (`__tests__/registry.test.ts`). |
| `pnpm build` | Builds CommonJS (`dist/index.js`), ESM (`dist/index.mjs`), and TypeScript declarations (`dist/index.d.ts`) via `tsup`. |
| `npm pack --dry-run` | Verifies that only `dist/`, `package.json`, `README.md`, and `LICENSE` are included in the published tarball. |

---

## Design & Coding Standards

1. **Zero Runtime Dependencies**:
   - Never add packages to `"dependencies"` in `package.json`.
   - Keep `react` (`>=18.0.0`), `react-native` (`>=0.72.0`), and `zod` (`^4.0.0`) strictly as `"peerDependencies"`.
2. **Never Throw Unhandled Exceptions from `execute()`**:
   - `registry.execute(toolName, rawInput)` is designed to be called directly inside autonomous LLM tool-calling loops. All validation, policy, timeout, and handler errors must resolve to a structured `ToolExecutionResult` (`success: false`) with an actionable `llmFeedback` string.
3. **Strict TypeScript**:
   - Maintain full type inference from `inputSchema` (`z.infer<TSchema>`) to `policy` and `handler`.
   - Avoid `any`; use `unknown` and narrow types safely.
4. **Memory & Timer Safety**:
   - Always clean up timers (`clearTimeout`) in `finally` blocks and detach listeners on component unmount.

---

## Submitting a Pull Request

1. Create a feature or bugfix branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   ```
2. Add or update unit tests in `__tests__/registry.test.ts` covering your changes.
3. Run the verification suite:
   ```bash
   pnpm typecheck && pnpm test && pnpm build
   ```
4. Commit your changes with a clear, descriptive commit message (e.g., `feat(presets): add location sharing tool preset` or `fix(registry): handle empty string JSON input`).
5. Open a Pull Request against `main` and fill out the PR description explaining the motivation and test coverage.
