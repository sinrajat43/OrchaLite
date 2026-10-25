import Ajv, { ErrorObject, ValidateFunction } from 'ajv';

/**
 * Shared JSON Schema validator. Defaults from the schema are filled in, so
 * validate a copy when the original must stay untouched.
 */
export const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });

const compiled = new WeakMap<object, ValidateFunction>();

/**
 * Compiles a schema once and reuses the validator, e.g. a task's paramsSchema
 */
export function validatorFor(schema: object): ValidateFunction {
  let validate = compiled.get(schema);
  if (!validate) {
    validate = ajv.compile(schema);
    compiled.set(schema, validate);
  }
  return validate;
}

/**
 * Turns Ajv errors into messages such as "input.org must be string"
 */
export function formatSchemaErrors(errors: ErrorObject[] | null | undefined, prefix: string): string[] {
  const failedAnyOf = new Set(errors?.filter(e => e.keyword === 'anyOf').map(e => e.instancePath));
  return (errors ?? [])
    // Each failed branch of an anyOf reports its own error; the anyOf error alone says enough
    .filter(error => !(failedAnyOf.has(error.instancePath) && error.schemaPath.includes('/anyOf/')))
    .map(error => {
      const at = error.instancePath.replace(/\//g, '.');
      const allowed = error.keyword === 'enum' ? `: ${(error.params.allowedValues as unknown[]).join(', ')}` : '';
      return `${prefix}${at} ${error.message}${allowed}`;
    });
}
