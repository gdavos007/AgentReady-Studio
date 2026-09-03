/**
 * Runtime argument validation.
 *
 * A tool's `inputSchema` is a promise to the agent. Without validation that
 * promise is unenforced: a model that sends a string where a number belongs
 * reaches application code with the wrong type, and the failure surfaces
 * somewhere far away from the cause.
 *
 * Three validator shapes are accepted, and none of them is a dependency:
 * a Zod schema (duck-typed on `safeParse`), any Standard Schema
 * implementation (`~standard`), or a plain predicate. When none is supplied,
 * arguments are checked against the JSON Schema the tool already declares.
 */

/** One property of a {@link JsonSchema}. */
export interface JsonSchemaProperty {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  format?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: JsonSchemaProperty;
  [key: string]: unknown;
}

/** The JSON Schema subset this package reads and validates. */
export interface JsonSchema {
  type: 'object';
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

/** A Zod-like schema: anything exposing `safeParse`. */
export interface ZodLike<T = unknown> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown };
}

/** A Standard Schema implementation. */
export interface StandardSchemaLike<T = unknown> {
  '~standard': {
    validate(value: unknown):
      | { value: T; issues?: undefined }
      | { issues: ReadonlyArray<{ message: string; path?: unknown }> }
      | Promise<{ value: T; issues?: undefined } | { issues: ReadonlyArray<{ message: string }> }>;
  };
}

/** A predicate: return `true` to accept, or a string describing the problem. */
export type PredicateValidator<T = unknown> = (value: T) => boolean | string | void;

/** Any accepted validator. */
export type Validator<T = unknown> = ZodLike<T> | StandardSchemaLike<T> | PredicateValidator<T>;

/** The outcome of validating one call's arguments. */
export type ValidationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function isZodLike(value: unknown): value is ZodLike {
  return typeof (value as ZodLike | null)?.safeParse === 'function';
}

function isStandardSchema(value: unknown): value is StandardSchemaLike {
  return typeof (value as StandardSchemaLike | null)?.['~standard']?.validate === 'function';
}

/**
 * Validates `args`, preferring an explicit validator over the JSON Schema.
 *
 * Async because Standard Schema permits async validation; Zod and predicate
 * validators resolve immediately.
 */
export async function validateArguments<T = unknown>(
  args: unknown,
  options: { schema?: JsonSchema; validator?: Validator<T> },
): Promise<ValidationResult<T>> {
  const { validator, schema } = options;

  if (validator) {
    if (isZodLike(validator)) {
      const result = validator.safeParse(args);
      return result.success
        ? { ok: true, value: result.data as T }
        : { ok: false, errors: describeZodError(result.error) };
    }

    if (isStandardSchema(validator)) {
      const result = await validator['~standard'].validate(args);
      if ('issues' in result && result.issues) {
        return { ok: false, errors: result.issues.map((issue) => issue.message) };
      }
      return { ok: true, value: (result as { value: T }).value };
    }

    if (typeof validator === 'function') {
      const verdict = (validator as PredicateValidator)(args as T);
      if (verdict === true || verdict === undefined) return { ok: true, value: args as T };
      return { ok: false, errors: [typeof verdict === 'string' ? verdict : 'Arguments failed validation.'] };
    }
  }

  if (schema) {
    const errors = validateAgainstJsonSchema(args, schema);
    return errors.length === 0 ? { ok: true, value: args as T } : { ok: false, errors };
  }

  return { ok: true, value: args as T };
}

/** Flattens a Zod error into readable messages without importing Zod. */
function describeZodError(error: unknown): string[] {
  const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> })?.issues;
  if (!Array.isArray(issues)) return ['Arguments failed validation.'];
  return issues.map((issue) => {
    const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message ?? 'invalid'}`;
  });
}

/**
 * Validates a value against the JSON Schema subset this package emits.
 *
 * Deliberately partial — it enforces what a tool schema actually declares
 * (types, required, enums, ranges, the common string formats) rather than
 * pretending to be a complete JSON Schema implementation. Anything it does not
 * understand is passed rather than rejected, so an unrecognised keyword can
 * never reject a valid call.
 */
export function validateAgainstJsonSchema(value: unknown, schema: JsonSchema): string[] {
  const errors: string[] = [];

  // A call with no argument object is the same as a call with `{}`: an agent
  // legitimately omits the payload when the schema requires nothing. Rejecting
  // it would make a zero-required tool uncallable in its most natural form.
  const candidate = value === undefined || value === null ? {} : value;

  if (typeof candidate !== 'object' || Array.isArray(candidate)) {
    return [`Expected an object of arguments, received ${describeType(value)}.`];
  }

  const args = candidate as Record<string, unknown>;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  for (const name of required) {
    if (!(name in args) || args[name] === undefined || args[name] === null) {
      errors.push(`Missing required parameter "${name}".`);
    }
  }

  if (schema.additionalProperties === false) {
    for (const name of Object.keys(args)) {
      if (!(name in properties)) errors.push(`Unknown parameter "${name}".`);
    }
  }

  for (const [name, definition] of Object.entries(properties)) {
    if (!(name in args) || args[name] === undefined) continue;
    errors.push(...validateProperty(name, args[name], definition));
  }

  return errors;
}

function validateProperty(name: string, value: unknown, definition: JsonSchemaProperty): string[] {
  const errors: string[] = [];
  const { type } = definition;

  if (type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      errors.push(`"${name}" must be an integer, received ${describeType(value)}.`);
      return errors;
    }
  } else if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      errors.push(`"${name}" must be a number, received ${describeType(value)}.`);
      return errors;
    }
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') {
      errors.push(`"${name}" must be a boolean, received ${describeType(value)}.`);
      return errors;
    }
  } else if (type === 'string') {
    if (typeof value !== 'string') {
      errors.push(`"${name}" must be a string, received ${describeType(value)}.`);
      return errors;
    }
  } else if (type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`"${name}" must be an array, received ${describeType(value)}.`);
      return errors;
    }
  } else if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`"${name}" must be an object, received ${describeType(value)}.`);
      return errors;
    }
  }

  if (Array.isArray(definition.enum) && !definition.enum.includes(value)) {
    errors.push(`"${name}" must be one of ${definition.enum.map((entry) => JSON.stringify(entry)).join(', ')}.`);
  }

  if (typeof value === 'number') {
    if (typeof definition.minimum === 'number' && value < definition.minimum) {
      errors.push(`"${name}" must be at least ${definition.minimum}.`);
    }
    if (typeof definition.maximum === 'number' && value > definition.maximum) {
      errors.push(`"${name}" must be at most ${definition.maximum}.`);
    }
  }

  if (typeof value === 'string') {
    if (typeof definition.minLength === 'number' && value.length < definition.minLength) {
      errors.push(`"${name}" must be at least ${definition.minLength} character(s).`);
    }
    if (typeof definition.maxLength === 'number' && value.length > definition.maxLength) {
      errors.push(`"${name}" must be at most ${definition.maxLength} character(s).`);
    }
    if (typeof definition.pattern === 'string' && !safeMatch(value, definition.pattern)) {
      errors.push(`"${name}" does not match the required pattern.`);
    }
    const formatError = validateFormat(name, value, definition.format);
    if (formatError) errors.push(formatError);
  }

  return errors;
}

/** The string formats a form-derived schema actually produces. */
function validateFormat(name: string, value: string, format: string | undefined): string | null {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : `"${name}" must be an email address.`;
    case 'uri':
    case 'url':
      try {
        new URL(value);
        return null;
      } catch {
        return `"${name}" must be an absolute URL.`;
      }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : `"${name}" must be a date (YYYY-MM-DD).`;
    case 'date-time':
      return Number.isNaN(Date.parse(value)) ? `"${name}" must be an ISO-8601 date-time.` : null;
    default:
      // An unrecognised format is a hint to the model, not a constraint.
      return null;
  }
}

/** A hostile `pattern` must not take the page down with a bad regex. */
function safeMatch(value: string, pattern: string): boolean {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return true;
  }
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}
