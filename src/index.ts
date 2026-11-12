import { z } from 'zod';
import { ToolRegistry } from './registry';
import type {
  PolicyResolver,
  ToolDefinition,
  ToolExecutionResult,
  ToolPolicy,
  ToolRegistryOptions,
} from './types';

export * from './types';
export * from './biometrics';
export * from './registry';
export * from './ApprovalContext';
export * from './AgentApprovalSheet';
export * from './presets';

/**
 * Configuration for `createGuardrails()`, extending `ToolRegistryOptions` with
 * custom default policies and granular tool permission checks.
 */
export interface GuardrailConfig extends ToolRegistryOptions {
  /**
   * Per-tool policy overrides mapped by tool name.
   * Takes precedence over a tool's own `policy` definition and `defaultPolicy`.
   */
  permissions?: Record<string, PolicyResolver<unknown>>;
  /**
   * Optional allowlist of tool names. If specified, any tool not in this list resolves to `'deny'`.
   */
  allowedTools?: string[];
  /**
   * Optional blocklist of tool names. Any tool in this list always resolves to `'deny'`.
   */
  blockedTools?: string[];
  /**
   * Optional custom permission check callback evaluated before tool execution.
   * Return a `ToolPolicy` ('auto' | 'confirm' | 'biometric' | 'deny') or a boolean
   * (`false` -> `'deny'`, `true` -> falls back to tool policy / `defaultPolicy`).
   */
  checkPermission?: (
    toolName: string,
    parsedInput: unknown,
  ) => ToolPolicy | boolean | Promise<ToolPolicy | boolean>;
}

/**
 * Guardrail-enabled `ToolRegistry` returned by `createGuardrails()`.
 */
export class GuardrailRegistry extends ToolRegistry {
  private readonly guardrailConfig: GuardrailConfig;

  constructor(config: GuardrailConfig = {}) {
    super({
      ...config,
      defaultPolicy: config.defaultPolicy ?? 'auto',
    });
    this.guardrailConfig = config;
  }

  /**
   * Evaluate the effective permission policy for a given tool and input,
   * accounting for `blockedTools`, `allowedTools`, `permissions`, `checkPermission`,
   * the tool's own policy, and `defaultPolicy`.
   */
  public async checkToolPermission(
    toolName: string,
    parsedInput?: unknown,
  ): Promise<ToolPolicy> {
    const {
      blockedTools,
      allowedTools,
      permissions,
      checkPermission,
      defaultPolicy = 'auto',
    } = this.guardrailConfig;

    if (blockedTools && blockedTools.includes(toolName)) {
      return 'deny';
    }

    if (allowedTools && !allowedTools.includes(toolName)) {
      return 'deny';
    }

    if (checkPermission) {
      const customResult = await checkPermission(toolName, parsedInput);
      if (typeof customResult === 'boolean') {
        if (!customResult) {
          return 'deny';
        }
      } else {
        return customResult;
      }
    }

    const permissionOverride = permissions?.[toolName];
    if (permissionOverride !== undefined) {
      return typeof permissionOverride === 'function'
        ? await permissionOverride(parsedInput)
        : permissionOverride;
    }

    const tool = this.getTool(toolName);
    if (tool?.policy !== undefined) {
      return typeof tool.policy === 'function'
        ? await tool.policy(parsedInput)
        : tool.policy;
    }

    return defaultPolicy;
  }

  public override register<TSchema extends z.ZodType, TOutput = unknown>(
    name: string,
    definition: ToolDefinition<TSchema, TOutput>,
  ): this {
    const originalPolicy = definition.policy;
    const wrappedDefinition: ToolDefinition<TSchema, TOutput> = {
      ...definition,
      policy: async (parsedInput: z.infer<TSchema>): Promise<ToolPolicy> => {
        const {
          blockedTools,
          allowedTools,
          permissions,
          checkPermission,
          defaultPolicy = 'auto',
        } = this.guardrailConfig;

        if (blockedTools && blockedTools.includes(name)) {
          return 'deny';
        }

        if (allowedTools && !allowedTools.includes(name)) {
          return 'deny';
        }

        if (checkPermission) {
          const customResult = await checkPermission(name, parsedInput);
          if (typeof customResult === 'boolean') {
            if (!customResult) {
              return 'deny';
            }
          } else {
            return customResult;
          }
        }

        const permissionOverride = permissions?.[name];
        if (permissionOverride !== undefined) {
          return typeof permissionOverride === 'function'
            ? await permissionOverride(parsedInput)
            : permissionOverride;
        }

        if (originalPolicy !== undefined) {
          return typeof originalPolicy === 'function'
            ? await originalPolicy(parsedInput)
            : originalPolicy;
        }

        return defaultPolicy;
      },
    };

    return super.register(name, wrappedDefinition);
  }

  public override async execute<TOutput = unknown>(
    toolName: string,
    rawInput: unknown,
  ): Promise<ToolExecutionResult<TOutput>> {
    return super.execute<TOutput>(toolName, rawInput);
  }
}

/**
 * Factory function creating a guardrail-configured `GuardrailRegistry` with
 * support for custom `defaultPolicy`, per-tool `permissions`, `allowedTools` / `blockedTools`,
 * and `checkPermission` hooks.
 */
export function createGuardrails(
  config: GuardrailConfig = {},
): GuardrailRegistry {
  return new GuardrailRegistry(config);
}
