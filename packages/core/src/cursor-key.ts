import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AUTHORITY_CURSOR_KEY_FORMAT = "taric-authority-cursor-key";
export const AUTHORITY_CURSOR_KEY_VERSION = 1;
export const AUTHORITY_CURSOR_KEY_FILE = ".taric-context-cursor-key.v1";

/** Cursor failures are public, content-free errors, including invalid key state. */
export class InvalidCursorError extends Error {
  readonly code = "invalid_cursor";
  constructor(message = "invalid context continuation cursor") { super(message); this.name = "InvalidCursorError"; }
}

interface CursorKeyDocument {
  format: typeof AUTHORITY_CURSOR_KEY_FORMAT;
  version: typeof AUTHORITY_CURSOR_KEY_VERSION;
  authority_digest: string;
  key_id: string;
  created_at: string;
  key: string;
}

function authorityDigest(root: string, authority: string): string {
  // Authority IDs are stable opaque identifiers, including PostgreSQL UUIDs.
  // Interpreting them as relative paths would bind cursors to the process cwd.
  return createHash("sha256").update(JSON.stringify([realpathSync(root), authority])).digest("hex");
}
function keyDocument(root: string, authority: string): CursorKeyDocument {
  return { format: AUTHORITY_CURSOR_KEY_FORMAT, version: AUTHORITY_CURSOR_KEY_VERSION, authority_digest: authorityDigest(root, authority), key_id: randomBytes(16).toString("hex"), created_at: new Date().toISOString(), key: randomBytes(32).toString("base64url") };
}
function readDocument(root: string, authority: string): CursorKeyDocument {
  const path = join(root, AUTHORITY_CURSOR_KEY_FILE);
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new InvalidCursorError("invalid cursor key permissions");
  const document = JSON.parse(readFileSync(path, "utf8")) as CursorKeyDocument;
  if (document.format !== AUTHORITY_CURSOR_KEY_FORMAT || document.version !== AUTHORITY_CURSOR_KEY_VERSION || document.authority_digest !== authorityDigest(root, authority)
    || !/^[a-f0-9]{32}$/.test(document.key_id) || typeof document.key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(document.key) || Buffer.from(document.key, "base64url").length !== 32) throw new InvalidCursorError("invalid cursor key format or authority binding");
  return document;
}

/** Missing keys can be initialized only by a fresh query, never continuation. */
export function loadAuthorityCursorKey(root: string, authority: string, create: boolean): Buffer {
  try {
    if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
    return Buffer.from(readDocument(root, authority).key, "base64url");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause instanceof InvalidCursorError ? cause : new InvalidCursorError("invalid cursor key format or authority binding");
    if (!create) throw new InvalidCursorError();
    try {
      const document = keyDocument(root, authority);
      const path = join(root, AUTHORITY_CURSOR_KEY_FILE);
      writeFileSync(path, `${JSON.stringify(document)}\n`, { flag: "wx", mode: 0o600 });
      chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new InvalidCursorError("cursor key could not be created");
    }
    return loadAuthorityCursorKey(root, authority, false);
  }
}

/** Atomic replacement prevents another instance from observing a partial key. */
export function rotateAuthorityCursorKey(root: string, authority: string): { version: number; key_id: string } {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const document = keyDocument(root, authority);
  const path = join(root, AUTHORITY_CURSOR_KEY_FILE);
  const temporary = join(root, `.cursor-key-${document.key_id}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(document)}\n`, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch {
    try { unlinkSync(temporary); } catch { /* A failed publication may already have renamed the file. */ }
    throw new InvalidCursorError("cursor key could not be rotated");
  }
  return { version: document.version, key_id: document.key_id };
}
