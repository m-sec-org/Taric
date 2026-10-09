import { Ajv2020, type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";

/** Shared JSON Schema validator used at Taric API boundaries. */
export const schemaValidator = new Ajv2020({ allErrors: true, strict: true });
schemaValidator.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
schemaValidator.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);

export function compileSchema<T>(schema: AnySchema): ValidateFunction<T> {
  return schemaValidator.compile<T>(schema);
}
