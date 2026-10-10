import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";

const schema = JSON.parse(readFileSync(new URL("../packages/schemas/dist/schemas/v1/core.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addFormat("uuid", /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
ajv.addFormat("date-time", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/);
ajv.addSchema(schema);
const names = Object.keys(schema.$defs);
for (const name of names) ajv.getSchema(`${schema.$id}#/$defs/${name}`);
console.log(`ajv strict compiled ${names.length} defs ok`);
