import { randomBytes } from "node:crypto";

export interface SchemaMetadata {
  schema_version: string;
  core_version: string;
  created_at: string;
}

/** RFC 9562 UUIDv7 with millisecond timestamp ordering. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  const timestamp = BigInt(now) & 0xffffffffffffn;
  for (let i = 5; i >= 0; i--) bytes[i] = Number((timestamp >> BigInt((5 - i) * 8)) & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class DisplayIdAllocator {
  #next: number;
  constructor(start = 1) {
    if (!Number.isSafeInteger(start) || start < 1) throw new RangeError("start must be a positive safe integer");
    this.#next = start;
  }
  next(): string {
    const value = this.#next++;
    return `TAR-${String(value).padStart(6, "0")}`;
  }
  get nextSequence(): number { return this.#next; }
}

export function schemaMetadata(coreVersion = "0.1.0"): SchemaMetadata {
  return { schema_version: "1.0.0", core_version: coreVersion, created_at: new Date().toISOString() };
}
