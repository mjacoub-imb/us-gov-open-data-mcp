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
// flows straight into a server-side fetch(). Restrict it to plausible
// public-hostname shapes and block loopback/link-local/private targets.

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const BLOCKED_PREFIXES = ["localhost", "127.", "10.", "192.168.", "169.254.", "0."];

/** Validate and normalize a Socrata portal hostname. Throws on anything unsafe. */
export function assertPortal(domain: string): string {
  const d = domain.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "");
  if (!d || !HOSTNAME_RE.test(d)) {
    throw new Error(`socrata: "${domain}" doesn't look like a valid portal hostname (expected e.g. "data.ny.gov")`);
  }
  if (BLOCKED_PREFIXES.some(p => d.startsWith(p)) || d.includes("@")) {
    throw new Error(`socrata: portal "${d}" is not allowed`);
  }
  return d;
}

/** Escape a value for safe interpolation into a SoQL $where clause. */
export function soqlEscape(value: string | number): string {
  return String(value).replace(/'/g, "''");
}

// ─── Per-portal client pool ──────────────────────────────────────────────

const portalClients = new Map<string, ApiClient>();

function portal(domain: string): ApiClient {
  const d = assertPortal(domain);
  let client = portalClients.get(d);
  if (!client) {
    client = createClient({
      baseUrl: `https://${d}`,
      name: `socrata:${d}`,
      auth: { type: "header", envParams: { "X-App-Token": "SOCRATA_APP_TOKEN" } },
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
  const raw = await client.get<any>(`/api/views/${datasetId}.json`);
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
  return client.get<SocrataRecord[]>(`/resource/${datasetId}.json`, {
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
