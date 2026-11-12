import { z } from 'zod';
import type {
  ClaudeToolSchema,
  MCPToolSchema,
  OpenAIToolSchema,
} from './types';

export interface SchemaExportOptions {
  /**
   * Enable OpenAI Structured Outputs strict mode (`strict: true`),
   * recursively enforcing `additionalProperties: false` on object schemas.
   */
  strict?: boolean;
}

/**
 * Recursively normalize a JSON Schema object for OpenAI strict mode (`strict: true`)
 * by ensuring `additionalProperties: false` on all `type: 'object'` nodes.
 */
function applyStrictObjectConstraints(
  node: Record<string, unknown>,
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...node };

  if (clone.type === 'object' || clone.properties) {
    if (clone.additionalProperties === undefined) {
      clone.additionalProperties = false;
    }

    if (clone.properties && typeof clone.properties === 'object') {
      const nextProps: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(
        clone.properties as Record<string, unknown>,
      )) {
        nextProps[key] =
          val && typeof val === 'object' && !Array.isArray(val)
            ? applyStrictObjectConstraints(val as Record<string, unknown>)
            : val;
      }
      clone.properties = nextProps;
    }
  }

  if (
    clone.items &&
    typeof clone.items === 'object' &&
    !Array.isArray(clone.items)
  ) {
    clone.items = applyStrictObjectConstraints(
      clone.items as Record<string, unknown>,
    );
  }

  return clone;
}

/**
 * Unwrap top-level or nested Zod `.transform()` / `.pipe()` definitions to extract
 * the input schema when needed as a fallback.
 */
function unwrapInputSchema(schema: z.ZodType): z.ZodType {
  const def = (
    schema as unknown as {
      _zod?: { def?: { type?: string; in?: z.ZodType; schema?: z.ZodType } };
    }
  )._zod?.def;

  if (def?.type === 'pipe' && def.in) {
    return unwrapInputSchema(def.in);
  }
  if (def?.type === 'transform' && def.schema) {
    return unwrapInputSchema(def.schema);
  }
  return schema;
}

/**
 * Safely convert any Zod v4 schema—including schemas using `.transform()`, `.refine()`,
 * `.superRefine()`, `.default()`, and `.pipe()`—into a `draft-07` JSON Schema object
 * representing the LLM input contract without throwing runtime errors.
 */
export function zodToJsonSchemaSafe(
  schema: z.ZodType,
  options: SchemaExportOptions = {},
): Record<string, unknown> {
  let rawJsonSchema: Record<string, unknown>;

  try {
    rawJsonSchema = z.toJSONSchema(schema, {
      target: 'draft-07',
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
  } catch {
    try {
      const unwrapped = unwrapInputSchema(schema);
      rawJsonSchema = z.toJSONSchema(unwrapped, {
        target: 'draft-07',
        io: 'input',
        unrepresentable: 'any',
      }) as Record<string, unknown>;
    } catch {
      rawJsonSchema = {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {},
      };
    }
  }

  if (options.strict) {
    return applyStrictObjectConstraints(rawJsonSchema);
  }

  return rawJsonSchema;
}

/**
 * Convert a named Zod tool schema into an OpenAI function-calling tool definition.
 * Safely handles `.transform()` and `.refine()` and supports `strict: true` mode.
 */
export function zodToOpenAISchema(
  name: string,
  description: string,
  inputSchema: z.ZodType,
  options: SchemaExportOptions = {},
): OpenAIToolSchema {
  const parameters = zodToJsonSchemaSafe(inputSchema, options);

  return {
    type: 'function',
    function: {
      name,
      description,
      ...(options.strict !== undefined ? { strict: options.strict } : {}),
      parameters,
    },
  };
}

/**
 * Convert a named Zod tool schema into an Anthropic Claude `input_schema` tool definition.
 * Safely handles `.transform()` and `.refine()` and supports `strict: true` constraints.
 */
export function zodToClaudeSchema(
  name: string,
  description: string,
  inputSchema: z.ZodType,
  options: SchemaExportOptions = {},
): ClaudeToolSchema {
  return {
    name,
    description,
    input_schema: zodToJsonSchemaSafe(inputSchema, options),
  };
}

/**
 * Convert a named Zod tool schema into a Model Context Protocol (MCP) `inputSchema` tool definition.
 * Safely handles `.transform()` and `.refine()`.
 */
export function zodToMCPSchema(
  name: string,
  description: string,
  inputSchema: z.ZodType,
  options: SchemaExportOptions = {},
): MCPToolSchema {
  return {
    name,
    description,
    inputSchema: zodToJsonSchemaSafe(inputSchema, options),
  };
}
