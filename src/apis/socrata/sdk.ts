/**
 * Socrata Open Data (SODA) SDK — state & city government open-data portals.
 *
 * Hundreds of state and local governments publish data through Socrata
 * (data.ny.gov, data.texas.gov, data.cityofchicago.org, etc.). Unlike every
 * other module in this repo, the portal (base URL) is chosen per-call, not
 * fixed at import time — so this module maintains a small pool of clients,
 * one per portal, created on first use.
 *
 * API docs: https://dev.socrata.com/
 * Discovery API: https://api.us.socrata.com/api/catalog/v1 (searches across ALL portals)
 * No auth required; optional SOCRATA_APP_TOKEN raises the per-portal rate limit.
 */

import { createClient, type ApiClient } from "../../shared/client.js";

// ─── Known portals (probe-verified — NOT every state runs Socrata) ────

/** State open-data portals confirmed to be Socrata-backed. Not exhaustive — many states use CKAN or other platforms instead (e.g. California, Hawaii, Iowa). */
export const STATE_PORTALS: Record<string, string> = {
  CT: "data.ct.gov",
  DE: "data.delaware.gov",
  IL: "data.illinois.gov",
  MD: "opendata.maryland.gov",
  MI: "data.michigan.gov",
  MO: "data.mo.gov",
  NJ: "data.nj.gov",
  NY: "data.ny.gov",
  OR: "data.oregon.gov",
  PA: "data.pa.gov",
  TX: "data.texas.gov",
  UT: "opendata.utah.gov",
  VT: "data.vermont.gov",
  WA: "data.wa.gov",
  CO: "data.colorado.gov",
};

/** City/county open-data portals confirmed to be Socrata-backed. */
export const CITY_PORTALS: Record<string, string> = {
  "New York City": "data.cityofnewyork.us",
  "Chicago": "data.cityofchicago.org",
  "Seattle": "data.seattle.gov",
  "San Francisco": "data.sfgov.org",
  "Austin": "data.austintexas.gov",
  "Los Angeles": "data.lacity.org",
  "Kansas City": "data.kcmo.org",
  "Cook County, IL": "datacatalog.cookcountyil.gov",
  "Montgomery County, MD": "data.montgomerycountymd.gov",
};

/** Federal agencies that also happen to run Socrata portals (useful for cross-referencing). */
export const FEDERAL_PORTALS: Record<string, string> = {
  "HealthData.gov": "healthdata.gov",
};

// ─── Types ─────────────────────────────────────────────────────────────

export interface SocrataRecord { [key: string]: string | number | null; }

export interface CatalogResult {
  id: string;
  name: string;
  description: string;
  domain: string;
  category: string | null;
  attribution: string | null;
  updatedAt: string | null;
  rowCount: number | null;
  link: string;
}

export interface DatasetColumn {
  fieldName: string;
  name: string;
  dataTypeName: string;
  description: string | null;
}

// ─── Portal validation (SSRF guard) ─────────────────────────────────────
//
// `domain` is caller-supplied (ultimately LLM/user-driven text), and it
// flows straight into a server-side fetch() carrying our SOCRATA_APP_TOKEN.
// A denylist of string prefixes ("127.", "10.", ...) is NOT sufficient here:
// it misses whole private ranges (172.16.0.0/12), internal hostnames that
// don't look like IPs at all (postgres.railway.internal,
// metadata.google.internal), and encoded IP literals (octal "0177.0.0.1" ==
// 127.0.0.1 to a getaddrinfo()-based resolver). Any of those would both
// reach an internal service AND hand it our app token.
//
// So the default is an allowlist: only the curated STATE_PORTALS /
// CITY_PORTALS / FEDERAL_PORTALS above are permitted, and only those ever
// receive the SOCRATA_APP_TOKEN header (see `portal()` below). Operators who
// need to reach a Socrata portal outside the curated list can opt in via
// SOCRATA_ALLOW_ANY_PORTAL=true, in which case the app token is still
// withheld from unlisted hosts and the private-range checks below apply as
// defense in depth (DNS-rebinding — a hostname that resolves to a private IP
// only at request time — is NOT covered; that requires validating the
// resolved address at connect time, not just the hostname string).

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const KNOWN_PORTALS = new Set<string>(
  [...Object.values(STATE_PORTALS), ...Object.values(CITY_PORTALS), ...Object.values(FEDERAL_PORTALS)]
    .map(d => d.toLowerCase()),
);

/** Read at call time (not import time) — same convention as createClient's
 *  auth resolution, and lets ops toggle this without restarting the process. */
function allowAnyPortal(): boolean {
  return /^(1|true)$/i.test(process.env.SOCRATA_ALLOW_ANY_PORTAL ?? "");
}

function normalizeHostname(domain: string): string {
  const d = domain.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (!d || !HOSTNAME_RE.test(d) || d.includes("@")) {
    throw new Error(`socrata: "${domain}" doesn't look like a valid portal hostname (expected e.g. "data.ny.gov")`);
  }
  return d;
}

/**
 * Parse a hostname as an IPv4 literal, honoring legacy inet_aton radix rules
 * (leading "0x" = hex, leading "0" = octal) that some resolvers still accept
 * and that string-prefix denylists silently miss (e.g. "0177.0.0.1" === 127.0.0.1).
 * Returns the four octets, or null if `host` isn't an all-numeric dotted quad.
 */
function parseIPv4Literal(host: string): [number, number, number, number] | null {
  const labels = host.split(".");
  if (labels.length !== 4) return null;
  const octets: number[] = [];
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
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets as [number, number, number, number];
}

function isPrivateOrReservedHost(host: string): boolean {
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

/** True only for portals on the curated allowlist — the only ones that get SOCRATA_APP_TOKEN attached. */
export function isKnownPortal(domain: string): boolean {
  return KNOWN_PORTALS.has(domain);
}

/** Validate and normalize a Socrata portal hostname. Throws on anything unsafe or unrecognized. */
export function assertPortal(domain: string): string {
  const d = normalizeHostname(domain);
  if (KNOWN_PORTALS.has(d)) return d;

  if (!allowAnyPortal()) {
    throw new Error(
      `socrata: "${d}" is not a recognized Socrata portal. Call socrata_list_portals for known hostnames, ` +
      `or set SOCRATA_ALLOW_ANY_PORTAL=true to permit other portals (advanced use — see docs).`,
    );
  }
  if (isPrivateOrReservedHost(d)) {
    throw new Error(`socrata: portal "${d}" is not allowed`);
  }
  return d;
}

/** Escape a value for safe interpolation into a SoQL $where clause. */
export function soqlEscape(value: string | number): string {
  return String(value).replace(/'/g, "''");
}

// ─── Per-portal client pool ──────────────────────────────────────────────

/**
 * Max distinct portal hostnames pooled at once. Comfortably above the ~25
 * curated portals (STATE_PORTALS + CITY_PORTALS + FEDERAL_PORTALS), so normal
 * usage never evicts anything. Exists for SOCRATA_ALLOW_ANY_PORTAL: without a
 * cap, a caller varying the `domain` argument across many distinct hostnames
 * would grow this Map — and, via createClient's disk-cache namespace per
 * `name`, a same-shaped cache.json namespace per hostname — without bound.
 */
export const MAX_PORTAL_CLIENTS = 100;

const portalClients = new Map<string, ApiClient>();

/** Exposed for tests/socrata-portal-validation.test.ts (pool-bound + eviction coverage). */
export function portalPoolSize(): number {
  return portalClients.size;
}

export function portal(domain: string): ApiClient {
  const d = assertPortal(domain);
  let client = portalClients.get(d);
  if (!client) {
    if (portalClients.size >= MAX_PORTAL_CLIENTS) {
      // Map preserves insertion order, so the first key is the
      // longest-untouched entry (`portalClients.delete`+`.set` on repeat
      // access would make this a true LRU, but this pool sees traffic
      // concentrated on the curated portals that stay well under the cap —
      // eviction only fires under sustained use of many distinct
      // SOCRATA_ALLOW_ANY_PORTAL hosts, where "oldest inserted" is an
      // adequate proxy for "least likely still in use"). Clear its disk
      // cache too, not just the in-memory client wrapper — otherwise the
      // per-portal cache.json namespace outlives the pool eviction and the
      // Map cap doesn't actually bound the memory it exists to bound.
      const oldest = portalClients.keys().next().value;
      if (oldest !== undefined) {
        portalClients.get(oldest)?.clearCache();
        portalClients.delete(oldest);
      }
    }
    client = createClient({
      baseUrl: `https://${d}`,
      name: `socrata:${d}`,
      // Only ever attach the app token to curated, known-safe portals — never
      // to a caller-supplied host admitted via SOCRATA_ALLOW_ANY_PORTAL, which
      // would otherwise hand our credential to a domain we don't control.
      auth: isKnownPortal(d)
        ? { type: "header", envParams: { "X-App-Token": "SOCRATA_APP_TOKEN" } }
        : undefined,
      rateLimit: { perSecond: 2, burst: 5 },
      cacheTtlMs: 6 * 60 * 60 * 1000, // 6 hours — state/local datasets update at varying cadences
    });
    portalClients.set(d, client);
  }
  return client;
}

/** Fixed discovery API — searches dataset metadata across every Socrata-hosted portal at once. */
const catalogApi = createClient({
  baseUrl: "https://api.us.socrata.com",
  name: "socrata-catalog",
  rateLimit: { perSecond: 2, burst: 5 },
  cacheTtlMs: 60 * 60 * 1000,
});

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Search the Socrata discovery catalog across one or more portals (or all of them).
 * Use this first to find a dataset's four-by-four ID before querying it.
 */
export async function searchDatasets(opts: {
  q?: string;
  domains?: string[];      // e.g. ["data.ny.gov", "data.texas.gov"]. Omit to search ALL Socrata portals.
  categories?: string[];
  tags?: string[];
  limit?: number;
  offset?: number;
}): Promise<{ results: CatalogResult[]; total: number }> {
  const domains = opts.domains?.map(assertPortal);
  const raw = await catalogApi.get<any>("/api/catalog/v1", {
    q: opts.q,
    domains: domains?.length ? domains.join(",") : undefined,
    categories: opts.categories,
    tags: opts.tags,
    only: "dataset",
    limit: opts.limit ?? 20,
    offset: opts.offset,
  });

  const results: CatalogResult[] = (raw.results ?? []).map((r: any) => ({
    id: r.resource?.id,
    name: r.resource?.name,
    description: r.resource?.description ?? null,
    domain: r.metadata?.domain ?? null,
    category: r.classification?.domain_category ?? null,
    attribution: r.resource?.attribution ?? null,
    updatedAt: r.resource?.updatedAt ?? null,
    rowCount: null, // not exposed by the catalog API — call getDatasetColumns/query for row counts
    link: r.link,
  }));

  return { results, total: raw.resultSetSize ?? results.length };
}

/** Get column/schema info for a dataset — required before querying, since SoQL needs exact field names. */
export async function getDatasetColumns(domain: string, datasetId: string): Promise<{
  name: string;
  description: string | null;
  columns: DatasetColumn[];
}> {
  const client = portal(domain);
  const raw = await client.get<any>(`/api/views/${encodeURIComponent(datasetId)}.json`);
  const columns: DatasetColumn[] = (raw.columns ?? []).map((c: any) => ({
    fieldName: c.fieldName,
    name: c.name,
    dataTypeName: c.dataTypeName,
    description: c.description ?? null,
  }));
  return { name: raw.name, description: raw.description ?? null, columns };
}

/** Run a SoQL query against a dataset on any Socrata portal. */
export async function queryDataset(domain: string, datasetId: string, opts: {
  select?: string;   // SoQL $select: "state, year, count(*)"
  where?: string;     // SoQL $where: "state = 'New York' AND year = 2023"
  group?: string;     // SoQL $group: "state, year"
  having?: string;    // SoQL $having
  order?: string;     // SoQL $order: "year DESC"
  limit?: number;     // max rows (Socrata default/max per page is 1000 unless raised)
  offset?: number;
  q?: string;         // full-text search across the dataset
} = {}): Promise<SocrataRecord[]> {
  const client = portal(domain);
  return client.get<SocrataRecord[]>(`/resource/${encodeURIComponent(datasetId)}.json`, {
    "$select": opts.select,
    "$where": opts.where,
    "$group": opts.group,
    "$having": opts.having,
    "$order": opts.order,
    "$limit": opts.limit ?? 1000,
    "$offset": opts.offset,
    "$q": opts.q,
  });
}

export function clearCache(): void {
  catalogApi.clearCache();
  for (const client of portalClients.values()) client.clearCache();
}
