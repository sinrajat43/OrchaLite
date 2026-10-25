import Ajv, { ErrorObject } from 'ajv';

/**
 * Shared JSON Schema validator. Defaults from the schema are filled in, so
 * validate a copy when the original must stay untouched.
 */
export const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

/**
 * Turns Ajv errors into messages such as "input.org must be string"
 */
export function formatSchemaErrors(errors: ErrorObject[] | null | undefined, prefix: string): string[] {
  return (errors ?? []).map(error => {
    const at = error.instancePath.replace(/\//g, '.');
    return `${prefix}${at} ${error.message}`;
  });
}
