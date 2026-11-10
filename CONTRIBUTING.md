# Contributing to `react-native-agent-guard`

Thank you for your interest in contributing to `react-native-agent-guard`! This guide covers setting up your local development environment, running tests, and submitting pull requests.

## Prerequisites

- **Node.js**: v20 LTS or newer
- **Package Manager**: `pnpm` (v9+)

## Local Development Setup

1. Clone the repository and install dependencies:

   ```bash
   pnpm install
   ```

2. Run TypeScript typechecking in strict mode:

   ```bash
   pnpm typecheck
   ```

3. Run the Jest test suite:

   ```bash
   pnpm test
   ```

4. Build the CommonJS, ESM, and TypeScript declaration bundles (`/dist`):

   ```bash
   pnpm build
   ```

## Pull Request Guidelines

- **Zero Runtime Dependencies**: Do not add runtime packages to `dependencies` in `package.json`. Keep `react`, `react-native`, and `zod` as `peerDependencies`.
- **Strict TypeScript**: All code in `src/` and `__tests__/` must pass `pnpm typecheck` without errors or `any` leaks.
- **Test Coverage**: Add or update unit tests in `__tests__/registry.test.ts` for any new features or bug fixes.
- **Clean Build**: Verify that `pnpm build` and `npm pack --dry-run` succeed before opening a pull request.
