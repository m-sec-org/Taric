import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Bind release evidence to the exact Core JavaScript files loaded by Node. */
export function runtimeImplementationDigest(directory = import.meta.dirname): string {
  const hasher = createHash("sha256");
  for (const filename of readdirSync(directory).filter((file) => file.endsWith(".js")).sort()) {
    hasher.update(filename).update("\0").update(readFileSync(join(directory, filename))).update("\0");
  }
  return `sha256:${hasher.digest("hex")}`;
}
