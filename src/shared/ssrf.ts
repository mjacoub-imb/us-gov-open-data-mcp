/**
 * Hostname validation for modules that accept a caller-supplied hostname
 * (rather than a fixed `baseUrl`) and must validate it before using it in a
 * server-side `fetch()` — an SSRF vector otherwise.
 *
 * Extracted from src/apis/socrata/sdk.ts, the first (and so far only)
 * module whose base host is chosen per-call instead of fixed at import
 * time. Per CLAUDE.md: "Any future module that talks to a variable/
 * multi-tenant host should follow that pattern (allowlist + no-credential-
 * to-unknown-host)" — this module is what lets it reuse the actual
 * validated logic instead of copying it.
 *
 * A denylist of string prefixes ("127.", "10.", ...) is NOT sufficient:
 * it misses whole private ranges (172.16.0.0/12), internal hostnames that
 * don't look like IPs at all (postgres.railway.internal,
 * metadata.google.internal), and encoded/shorthand IP literals (octal
 * "0177.0.0.1" == 127.0.0.1, shorthand "127.1" == 127.0.0.1 to a
 * getaddrinfo()-based resolver).
 *
 * DNS-rebinding (a hostname that resolves to a private IP only at request
 * time) is NOT covered here — that requires validating the resolved
 * address at connect time, not just the hostname string.
 */

export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * Strip scheme/path/port and lowercase a caller-supplied hostname, then
 * validate its shape. Throws a message naming the caller's own vocabulary
 * (`label`/`noun`/`example`) if the input doesn't look like a hostname.
 */
export function normalizeHostname(
  input: string,
  opts: { label: string; noun: string; example: string },
): string {
  const d = input.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (!d || !HOSTNAME_RE.test(d) || d.includes("@")) {
    throw new Error(`${opts.label}: "${input}" doesn't look like a valid ${opts.noun} (expected e.g. "${opts.example}")`);
  }
  return d;
}

/**
 * Parse a hostname as an IPv4 literal, honoring legacy inet_aton rules that
 * some resolvers (and Node's fetch/getaddrinfo) still accept and that naive
 * checks silently miss:
 *   - radix per label: leading "0x" = hex, leading "0" = octal
 *     (e.g. "0177.0.0.1" === 127.0.0.1)
 *   - shorthand forms with fewer than 4 labels, where the LAST label absorbs
 *     the remaining octets (e.g. "127.1" === 127.0.0.1, "172.16.1" ===
 *     172.16.0.1) — a 4-label-only parser lets these bypass the private-range
 *     check entirely even though they resolve to the same address.
 * Returns the four octets, or null if `host` isn't an all-numeric dotted
 * form inet_aton would accept.
 */
export function parseIPv4Literal(host: string): [number, number, number, number] | null {
  const labels = host.split(".");
  if (labels.length < 1 || labels.length > 4) return null;
  const parts: number[] = [];
  for (const label of labels) {
    // Number()/parseInt() with an implicit radix both read "0177" as decimal
    // 177, not octal 127 — the radix has to be picked explicitly per prefix,
    // or the octal/hex forms this function exists to catch parse as the
    // wrong (non-matching, so falsely "safe") value.
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(label)) n = parseInt(label, 16);
    else if (/^0[0-7]+$/.test(label)) n = parseInt(label, 8);
    else if (/^[0-9]+$/.test(label)) n = parseInt(label, 10);
    else return null;
    if (!Number.isInteger(n) || n < 0) return null;
    parts.push(n);
  }
  // inet_aton: every label except the last is a single octet (0-255); the
  // last label absorbs (5 - labels.length) octets worth of value, e.g. for
  // "127.1" (2 labels) the last label is the low 3 octets as one number.
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] > 255) return null;
  }
  const lastBits = 8 * (4 - (parts.length - 1));
  const lastMax = 2 ** lastBits - 1;
  if (parts[parts.length - 1] > lastMax) return null;

  const octets = parts.slice(0, -1);
  let rest = parts[parts.length - 1];
  for (let i = parts.length - 1; i < 4; i++) {
    const shift = 8 * (3 - i);
    octets.push(Math.floor(rest / 2 ** shift) % 256);
  }
  return octets as [number, number, number, number];
}

/** True for localhost, .local/.internal hostnames, and IPv4 literals in a private/reserved range. */
export function isPrivateOrReservedHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const ip = parseIPv4Literal(host);
  if (!ip) return false;
  const [a, b] = ip;
  return (
    a === 0 || a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
