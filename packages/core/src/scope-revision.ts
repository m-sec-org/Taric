import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { ScopePolicy } from "@taric/schemas";
import { ContractValidationError } from "./validation.js";

type ParsedTarget = {
  canonical: string;
  domain?: string;
  family?: 4 | 6;
  bytes?: number[];
  prefix?: number;
};

function fail(message: string): never {
  throw new ContractValidationError("validation_error", message);
}

function object(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)) || keys.some((key) => !(key in result))) {
    fail(`${name} must contain exactly ${keys.join(", ")}`);
  }
  return result;
}

function ipv6Bytes(value: string): number[] {
  let source = value.toLowerCase();
  const dotted = source.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.some((octet) => octet < 0 || octet > 255)) fail("invalid IPv6 address");
    const tail = `${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
    source = `${source.slice(0, -dotted[1]!.length)}${tail}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) fail("invalid IPv6 address");
  const left = halves[0] ? halves[0]!.split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(":") : [];
  const groups = [...left, ...Array(halves.length === 2 ? 8 - left.length - right.length : 0).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) fail("invalid IPv6 address");
  return groups.flatMap((group) => {
    const number = Number.parseInt(group, 16);
    return [number >> 8, number & 0xff];
  });
}

function ipv6Text(bytes: number[]): string {
  const groups = Array.from({ length: 8 }, (_, index) => ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < groups.length;) {
    if (groups[index] !== "0") { index += 1; continue; }
    let end = index + 1;
    while (end < groups.length && groups[end] === "0") end += 1;
    if (end - index > bestLength) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  if (bestStart < 0) return groups.join(":");
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLength).join(":");
  return `${left}::${right}`;
}

function mask(bytes: number[], prefix: number): number[] {
  return bytes.map((byte, index) => {
    const remaining = prefix - index * 8;
    if (remaining >= 8) return byte;
    if (remaining <= 0) return 0;
    return byte & (0xff << (8 - remaining));
  });
}

function parseTarget(value: unknown): ParsedTarget {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /\s/.test(value)) {
    fail("scope targets must be non-empty strings without whitespace");
  }
  if (/[?#@*\\]/.test(value) || value.includes("://")) fail("scope targets cannot contain URL, wildcard, or user-info syntax");
  const pieces = value.split("/");
  if (pieces.length > 2 || !pieces[0]) fail("scope target is not a domain, IP address, or CIDR");
  const address = pieces[0]!;
  const ipVersion = isIP(address);
  if (ipVersion) {
    const family = ipVersion as 4 | 6;
    const bits = family === 4 ? 32 : 128;
    const bytes = family === 4
      ? address.split(".").map((octet) => Number(octet))
      : ipv6Bytes(address);
    const prefix = pieces.length === 2 ? Number(pieces[1]) : bits;
    if (pieces.length === 2 && (!/^\d+$/.test(pieces[1]!) || !Number.isSafeInteger(prefix) || prefix < 0 || prefix > bits)) {
      fail("CIDR prefix is outside the address family range");
    }
    const network = mask(bytes, prefix);
    if (network.some((byte, index) => byte !== bytes[index])) fail("CIDR targets must use their canonical network address without host bits");
    const normalizedAddress = family === 4 ? network.join(".") : ipv6Text(network);
    const canonical = prefix === bits ? normalizedAddress : `${normalizedAddress}/${prefix}`;
    return { canonical, family, bytes: network, prefix };
  }
  if (pieces.length > 1 || /^\d+(?:\.\d+){3}$/.test(address) || address.includes(":")) {
    fail("scope target contains an invalid IP address or CIDR");
  }
  const withoutRootDot = address.endsWith(".") ? address.slice(0, -1) : address;
  const domain = domainToASCII(withoutRootDot).toLowerCase();
  const labels = domain.split(".");
  if (!domain || domain.length > 253 || labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    fail("scope target is not a valid DNS name");
  }
  return { canonical: domain, domain };
}

function targetContains(parent: ParsedTarget, child: ParsedTarget): boolean {
  if (parent.domain && child.domain) return child.domain === parent.domain || child.domain.endsWith(`.${parent.domain}`);
  if (parent.family !== child.family || !parent.bytes || !child.bytes || parent.prefix === undefined || child.prefix === undefined || parent.prefix > child.prefix) return false;
  return mask(child.bytes, parent.prefix).every((byte, index) => byte === parent.bytes![index]);
}

function normalizeTargets(value: unknown, name: string, minimum: number): { values: string[]; parsed: ParsedTarget[] } {
  if (!Array.isArray(value) || value.length < minimum) fail(`${name} must contain at least ${minimum} target(s)`);
  const parsed = value.map(parseTarget).sort((left, right) => left.canonical < right.canonical ? -1 : left.canonical > right.canonical ? 1 : 0);
  if (new Set(parsed.map((target) => target.canonical)).size !== parsed.length) fail(`${name} contains duplicate normalized targets`);
  return { values: parsed.map((target) => target.canonical), parsed };
}

function normalizeTime(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    fail(`${name} must be a fully qualified ISO timestamp`);
  }
  const date = value.slice(0, 10).split("-").map(Number);
  const [year, month, day] = date;
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > daysInMonth) {
    fail(`${name} contains an invalid calendar date`);
  }
  const clock = value.slice(11, 19).split(":").map(Number);
  if (clock[0]! > 23 || clock[1]! > 59 || clock[2]! > 59) fail(`${name} contains an invalid clock time`);
  if (!value.endsWith("Z")) {
    const offsetHours = Number(value.slice(-5, -3));
    const offsetMinutes = Number(value.slice(-2));
    if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) fail(`${name} contains an invalid timezone offset`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time)) fail(`${name} is invalid`);
  return new Date(time).toISOString();
}

/** Normalize the full authorization policy before it can enter canonical storage. */
export function normalizeScopePolicy(value: unknown): ScopePolicy {
  const input = object(value, "policy", ["allowed_targets", "excluded_targets", "protocols", "ports", "methods", "dns", "redirects", "valid_from", "valid_until"]);
  const allowed = normalizeTargets(input.allowed_targets, "allowed_targets", 1);
  const excluded = normalizeTargets(input.excluded_targets, "excluded_targets", 0);
  for (const denied of excluded.parsed) {
    if (allowed.parsed.some((target) => targetContains(denied, target))) fail("an excluded target fully contains an allowed target");
  }
  if (!Array.isArray(input.protocols) || input.protocols.length === 0) fail("protocols must contain at least one protocol");
  const supportedProtocols = new Set(["http", "https", "tcp", "udp"]);
  const protocols = input.protocols.map((protocol) => {
    if (typeof protocol !== "string" || !supportedProtocols.has(protocol.toLowerCase())) fail("protocol is unsupported");
    return protocol.toLowerCase() as ScopePolicy["protocols"][number];
  }).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (new Set(protocols).size !== protocols.length) fail("protocols contains duplicates");
  if (!Array.isArray(input.ports) || input.ports.length === 0) fail("ports must contain at least one explicit port range");
  const ranges = input.ports.map((entry) => {
    const port = object(entry, "port range", ["from", "to"]);
    if (!Number.isSafeInteger(port.from) || !Number.isSafeInteger(port.to) || Number(port.from) < 1 || Number(port.to) > 65535 || Number(port.from) > Number(port.to)) {
      fail("port ranges must use integers from 1 through 65535 with from <= to");
    }
    return { from: Number(port.from), to: Number(port.to) };
  }).sort((left, right) => left.from - right.from || left.to - right.to);
  const mergedPorts: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    const previous = mergedPorts.at(-1);
    if (previous && range.from <= previous.to) fail("port ranges cannot overlap");
    if (previous && range.from === previous.to + 1) previous.to = range.to;
    else mergedPorts.push({ ...range });
  }
  if (!Array.isArray(input.methods)) fail("methods must be an array");
  const methods = input.methods.map((method) => {
    if (typeof method !== "string" || method.length === 0 || method === "*" || !/^[!#$%&'+.^_`|~0-9A-Za-z*-]+$/.test(method)) fail("methods must be valid HTTP method tokens");
    return method.toUpperCase();
  }).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (new Set(methods).size !== methods.length) fail("methods contains duplicate normalized values");
  const hasHttp = protocols.some((protocol) => protocol === "http" || protocol === "https");
  if (hasHttp && methods.length === 0 || !hasHttp && methods.length > 0) fail("methods must be explicit for HTTP protocols and empty for TCP/UDP-only policy");
  const dns = object(input.dns, "dns", ["require_pinned_addresses", "reject_private_addresses", "max_addresses"]);
  if (typeof dns.require_pinned_addresses !== "boolean" || typeof dns.reject_private_addresses !== "boolean" || !Number.isSafeInteger(dns.max_addresses) || Number(dns.max_addresses) < 1 || Number(dns.max_addresses) > 256) {
    fail("DNS policy requires explicit booleans and max_addresses from 1 through 256");
  }
  const redirects = object(input.redirects, "redirects", ["max_hops", "same_scope_only"]);
  if (!Number.isSafeInteger(redirects.max_hops) || Number(redirects.max_hops) < 0 || Number(redirects.max_hops) > 20 || typeof redirects.same_scope_only !== "boolean") {
    fail("redirect policy requires max_hops from 0 through 20 and an explicit same_scope_only flag");
  }
  const validFrom = normalizeTime(input.valid_from, "valid_from");
  const validUntil = normalizeTime(input.valid_until, "valid_until");
  if (Date.parse(validFrom) >= Date.parse(validUntil)) fail("valid_until must be later than valid_from");
  return {
    allowed_targets: allowed.values,
    excluded_targets: excluded.values,
    protocols,
    ports: mergedPorts,
    methods,
    dns: {
      require_pinned_addresses: dns.require_pinned_addresses,
      reject_private_addresses: dns.reject_private_addresses,
      max_addresses: Number(dns.max_addresses),
    },
    redirects: { max_hops: Number(redirects.max_hops), same_scope_only: redirects.same_scope_only },
    valid_from: validFrom,
    valid_until: validUntil,
  };
}
