import { z } from 'zod';

/**
 * Convert the subset of Zod used for tool parameters into JSON Schema for the
 * model's tool definitions. Supports objects of strings, numbers, booleans,
 * enums, literals, and arrays, with optional/default/nullable wrappers and
 * .describe() annotations. Anything else throws at registration time rather
 * than producing a schema the model would misread.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const result = convert(unwrap(schema).schema);
  const description = schema.description;
  if (description && result.description === undefined) result.description = description;
  return result;
}

function unwrap(schema: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  let current = schema;
  let optional = false;
  for (;;) {
    if (current instanceof z.ZodOptional) {
      optional = true;
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      optional = true;
      current = current._def.innerType as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    return { schema: current, optional };
  }
}

function convert(schema: z.ZodTypeAny): Record<string, unknown> {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      const { schema: inner, optional } = unwrap(value);
      const prop = convert(inner);
      const description = value.description ?? inner.description;
      if (description && prop.description === undefined) prop.description = description;
      properties[key] = prop;
      if (!optional) required.push(key);
    }
    const result: Record<string, unknown> = { type: 'object', properties };
    if (required.length > 0) result.required = required;
    return result;
  }
  if (schema instanceof z.ZodString) return { type: 'string' };
  if (schema instanceof z.ZodNumber) {
    return { type: schema._def.checks.some(check => check.kind === 'int') ? 'integer' : 'number' };
  }
  if (schema instanceof z.ZodBoolean) return { type: 'boolean' };
  if (schema instanceof z.ZodEnum) return { type: 'string', enum: [...schema.options] };
  if (schema instanceof z.ZodLiteral) {
    const value = schema.value;
    return { type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string', enum: [value] };
  }
  if (schema instanceof z.ZodArray) {
    return { type: 'array', items: convert(unwrap(schema.element as z.ZodTypeAny).schema) };
  }
  throw new Error(`Unsupported Zod type for tool parameters: ${schema.constructor.name}`);
}
