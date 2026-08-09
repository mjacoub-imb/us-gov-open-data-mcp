/**
 * Lightweight API client factory with caching, retry, and rate limiting.
 *
 * Instead of an abstract class with 7 virtual methods, this uses a config
 * object to create a client. Each module calls createClient() once.
 *
 * Features:
 *   - Disk-backed TTL cache (survives MCP server restarts)
 *   - Timeout (30s default)
 *   - Retry with exponential backoff (429, 502, 503, 504)
 *   - Token-bucket rate limiting
 *   - Auth via query param, header, or request body
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// ─── Types ───────────────────────────────────────────────────────────

export interface ClientConfig {
  baseUrl: string;
  name: string;

  /** Auth configuration — how to attach credentials to requests */
  auth?: {
    /** Where to inject credentials: query string, request header, or POST body */
    type: "query" | "header" | "body";
    /**
     * Maps param/header names to env var names. Values are read from process.env at request time.
     * If the env var is unset, that param is silently omitted (graceful degradation).
     *
     * Examples:
     *   Single key:    envParams: { api_key: "FRED_API_KEY" }
     *   Key + email:   envParams: { key: "AQS_API_KEY", email: "AQS_EMAIL" }
     *   Bearer token:  envParams: { Authorization: "HUD_USER_TOKEN" }  (with prefix: "Bearer ")
     */
    envParams: Record<string, string>;
    /** Static params included on every authenticated request (e.g. { file_type: "json" } for FRED) */
    extraParams?: Record<string, string>;
    /** For header auth: prefix prepended to the first envParams value (e.g. "Bearer ") */
    prefix?: string;
  };

  /** Rate limiting */
  rateLimit?: { perSecond: number; burst: number };

  /** Default headers on every request (e.g. User-Agent for SEC) */
  defaultHeaders?: Record<string, string>;

  /** Cache TTL in ms (default: 5 min). Government data often updates daily/weekly — set
   *  higher for infrequent data: 1 hour = 3_600_000, 1 day = 86_400_000. Set 0 to disable. */
  cacheTtlMs?: number;

  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;

  /** Max retries for transient errors (429, 502, 503, 504). Default: 2.
   *  Increase for notoriously flaky upstream APIs (e.g. FBI CDE). */
  maxRetries?: number;

  /** Custom error detector — some APIs return 200 OK with errors in the body */
  checkError?: (data: unknown) => string | null;
}

/** Param values: string, number, string[] (for repeated keys like facets[series][]), or undefined to skip */
export type ParamValue = string | number | string[] | undefined;
export type Params = Record<string, ParamValue>;

/**
 * Shorthand for building query param objects. Drops `undefined`, `null`, and `""`.
 * Booleans become `"true"`/`"false"`. Arrays pass through (for repeated keys like `facets[series][]`).
 *
 * @example
 *   const { fromDateTime, toDateTime } = opts;
 *   const params = qp({ limit: opts.limit ?? 20, fromDateTime, toDateTime });
 *
 *   // rename a key + set a default
 *   const params = qp({ limit: 50, p_zip: opts.zip, sort: opts.sort ?? "desc" });
 */
export function qp(
  obj: Record<string, string | number | boolean | string[] | undefined | null>,
): Params {
  const out: Params = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "boolean") { out[k] = String(v); continue; }
    out[k] = v;
  }
  return out;
}

export interface ApiClient {
  get<T = unknown>(path: string, params?: Params): Promise<T>;
  /** GET returning the raw response body as text (for non-JSON endpoints like USGS RDB). */
  getText(path: string, params?: Params): Promise<string>;
  post<T = unknown>(path: string, body?: Record<string, unknown>, params?: Params): Promise<T>;
  clearCache(): void;
}

// ─── Token Bucket Rate Limiter ───────────────────────────────────────
//
// Queue-based token bucket that guarantees:
//   - Correct rate limiting even under concurrent acquire() calls
//   - FIFO fairness: callers are served in the order they arrive
//   - No thundering-herd: a single drain loop releases waiters one at a time
//   - Batch release: if multiple tokens accumulated while sleeping, all
//     eligible waiters are released in one pass
//
// NOTE: "Token" here refers to the classic rate-limiting concept (permission
// slips for API calls), NOT LLM/AI tokens. The name follows the standard
// CS algorithm: https://en.wikipedia.org/wiki/Token_bucket

export class TokenBucket {
  /** Max callers allowed to queue for a token at once. Without this, a burst
   *  far larger than the configured rate (e.g. many concurrent requests
   *  arriving over the HTTP transport) accumulates unbounded pending
   *  promises — this caps that growth and fails fast instead. */
  static readonly MAX_QUEUE_LENGTH = 500;

  private tokens: number;
  private lastRefill: number;
  private readonly queue: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly max: number, private readonly rate: number) {
    this.tokens = max;
    this.lastRefill = Date.now();
  }

  /** Refill tokens based on elapsed time since the last refill. */
  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.max,
      this.tokens + ((now - this.lastRefill) / 1000) * this.rate,
    );
    this.lastRefill = now;
  }

  /** Wait until a token is available, respecting FIFO order. */
  async acquire(): Promise<void> {
    this.refill();

    // Fast path: token available and nobody queued ahead of us
    if (this.tokens >= 1 && this.queue.length === 0) {
      this.tokens -= 1;
      return;
    }

    if (this.queue.length >= TokenBucket.MAX_QUEUE_LENGTH) {
      throw new Error("Rate limiter queue is full — too many concurrent requests. Try again shortly.");
    }

    // Slow path: join the queue and wait for the drain loop to release us
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
      this.scheduleDrain();
    });
  }

  /** Number of callers currently waiting for a token. */
  get pending(): number {
    return this.queue.length;
  }

  /** Ensure a drain timer is running to release queued callers. */
  private scheduleDrain(): void {
    if (this.timer !== null) return;

    const drain = (): void => {
      this.timer = null;
      this.refill();

      // Release as many queued callers as tokens allow
      while (this.queue.length > 0 && this.tokens >= 1) {
        this.tokens -= 1;
        this.queue.shift()!();
      }

      // Reschedule if more waiters remain
      if (this.queue.length > 0) {
        const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
        this.timer = setTimeout(drain, Math.max(waitMs, 1));
      }
    };

    const waitMs = Math.ceil(((1 - this.tokens) / this.rate) * 1000);
    this.timer = setTimeout(drain, Math.max(waitMs, 1));
  }
}

// ─── Disk-backed TTL Cache ────────────────────────────────────────────
//
// Single consolidated JSON file shared by all modules. Lazy-loaded on
// first cache miss. LRU eviction per module keeps memory bounded.
// Async writes don't block the event loop. Global write coalescing
// batches all module updates into one disk write.

function getCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const dir = join(base, "us-gov-open-data-mcp");
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    const fallback = join(tmpdir(), "us-gov-open-data-mcp");
    if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const CACHE_DIR = getCacheDir();
const CACHE_FILE = join(CACHE_DIR, "cache.json");
const MAX_ENTRIES_PER_MODULE = 200;

interface CacheEntry { data: unknown; expires: number; lastAccess: number; }

// ─── Global disk store (shared by all DiskCache instances) ───────────

let _globalLoaded = false;
let _globalDirty = false;
let _globalWriteTimer: ReturnType<typeof setTimeout> | undefined;

/** namespace → key → entry */
const _globalStore = new Map<string, Map<string, CacheEntry>>();

function loadGlobal(): void {
  if (_globalLoaded) return;
  _globalLoaded = true;
  try {
    if (!existsSync(CACHE_FILE)) {
      // Migrate: try loading legacy per-module files
      migrateLegacyFiles();
      return;
    }
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as Record<string, Record<string, CacheEntry>>;
    const now = Date.now();
    let totalLoaded = 0;
    for (const [ns, entries] of Object.entries(raw)) {
      const map = new Map<string, CacheEntry>();
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.expires > now) {
          map.set(key, entry);
          totalLoaded++;
        }
      }
      if (map.size > 0) _globalStore.set(ns, map);
    }
    if (totalLoaded > 0 && process.env.DEBUG_CACHE) {
      console.error(`Cache: loaded ${totalLoaded} entries from disk (${_globalStore.size} modules)`);
    }
  } catch {
    // Corrupted — start fresh
  }
}

/** One-time migration from the old per-module *.json files to the consolidated cache.json */
function migrateLegacyFiles(): void {
  try {
    const { readdirSync, unlinkSync } = require("node:fs") as typeof import("node:fs");
    const files = readdirSync(CACHE_DIR).filter((f: string) => f.endsWith(".json") && f !== "cache.json");
    if (files.length === 0) return;

    const now = Date.now();
    let migrated = 0;
    for (const file of files) {
      try {
        const ns = file.replace(/\.json$/, "");
        const raw = JSON.parse(readFileSync(join(CACHE_DIR, file), "utf-8")) as Record<string, CacheEntry>;
        const map = new Map<string, CacheEntry>();
        for (const [key, entry] of Object.entries(raw)) {
          if (entry.expires > now) {
            // Add lastAccess if missing (legacy entries don't have it)
            if (!entry.lastAccess) entry.lastAccess = now;
            map.set(key, entry);
            migrated++;
          }
        }
        if (map.size > 0) _globalStore.set(ns, map);
        unlinkSync(join(CACHE_DIR, file)); // Remove legacy file
      } catch {
        // Skip corrupt file
      }
    }
    if (migrated > 0) {
      _globalDirty = true;
      scheduleGlobalWrite();
      if (process.env.DEBUG_CACHE) {
        console.error(`Cache: migrated ${migrated} entries from ${files.length} legacy files`);
      }
    }
  } catch {
    // Migration is best-effort
  }
}

function scheduleGlobalWrite(): void {
  if (_globalWriteTimer) return;
  _globalWriteTimer = setTimeout(() => {
    _globalWriteTimer = undefined;
    if (!_globalDirty) return;
    _globalDirty = false;
    const now = Date.now();
    const obj: Record<string, Record<string, CacheEntry>> = {};
    for (const [ns, map] of _globalStore) {
      const entries: Record<string, CacheEntry> = {};
      for (const [key, entry] of map) {
        if (entry.expires > now) entries[key] = entry;
      }
      if (Object.keys(entries).length > 0) obj[ns] = entries;
    }
    // Async write — non-blocking
    writeFile(CACHE_FILE, JSON.stringify(obj), "utf-8").catch(() => {});
  }, 2000);
  if (typeof _globalWriteTimer === "object" && "unref" in _globalWriteTimer) {
    _globalWriteTimer.unref();
  }
}

// ─── Per-module cache interface ──────────────────────────────────────

class DiskCache {
  private ns: string;
  private ttlMs: number;

  constructor(ttlMs: number, name: string) {
    this.ttlMs = ttlMs;
    this.ns = name;
  }

  private getMap(): Map<string, CacheEntry> {
    loadGlobal(); // Lazy — only reads disk on first access
    let map = _globalStore.get(this.ns);
    if (!map) {
      map = new Map();
      _globalStore.set(this.ns, map);
    }
    return map;
  }

  get(key: string): unknown | undefined {
    const map = this.getMap();
    const entry = map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expires) {
      map.delete(key);
      _globalDirty = true;
      scheduleGlobalWrite();
      return undefined;
    }
    // Update last access for LRU
    entry.lastAccess = Date.now();
    return entry.data;
  }

  set(key: string, data: unknown): void {
    if (this.ttlMs <= 0) return;
    const map = this.getMap();

    // LRU eviction if at capacity
    if (map.size >= MAX_ENTRIES_PER_MODULE && !map.has(key)) {
      let oldestKey: string | undefined;
      let oldestAccess = Infinity;
      for (const [k, e] of map) {
        const access = e.lastAccess ?? e.expires - this.ttlMs;
        if (access < oldestAccess) {
          oldestAccess = access;
          oldestKey = k;
        }
      }
      if (oldestKey) map.delete(oldestKey);
    }

    const now = Date.now();
    map.set(key, { data, expires: now + this.ttlMs, lastAccess: now });
    _globalDirty = true;
    scheduleGlobalWrite();
  }

  clear(): void {
    _globalStore.delete(this.ns);
    _globalDirty = true;
    scheduleGlobalWrite();
  }

  get size(): number {
    const map = _globalStore.get(this.ns);
    if (!map) return 0;
    const now = Date.now();
    let count = 0;
    for (const entry of map.values()) {
      if (now <= entry.expires) count++;
    }
    return count;
  }
}

// ─── Fetch with timeout ──────────────────────────────────────────────
//
// The AbortController's timer must stay alive until the response BODY is
// fully read, not just until headers arrive. `fetch()` resolves as soon as
// headers are in; a slow/stalled upstream can then trickle the body forever
// with no deadline unless the same signal still covers `res.json()`/`.text()`.
// So `fetchTimeout` returns the live timer for the caller to clear once body
// consumption finishes (successfully or not) — never before.

interface TimedResponse { res: Response; clearTimer: () => void }

async function fetchTimeout(url: string, init: RequestInit | undefined, timeoutMs: number): Promise<TimedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const clearTimer = () => clearTimeout(timer);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { res, clearTimer };
  } catch (e) {
    clearTimer();
    throw e;
  }
}

/** Max response body size we'll read into memory (50MB). Guards against a
 *  slow/malicious upstream streaming an unbounded body into process memory. */
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

/** Read a response body as text, aborting once it exceeds `maxBytes`. */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return res.text();

  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`Response body exceeded ${(maxBytes / 1024 / 1024).toFixed(0)}MB limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text;
}

// ─── Retry logic ─────────────────────────────────────────────────────

const RETRYABLE = [429, 502, 503, 504];

/** Ceiling on how long we'll sleep for a server-supplied Retry-After — an
 *  upstream sending "Retry-After: 86400" shouldn't be able to hang a request
 *  for a full day. */
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Parse a `Retry-After` header value.
 * RFC 7231 allows either delta-seconds (an integer) or an HTTP-date.
 * Returns the wait time in ms, or null if the header is absent/unparseable.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  // Delta-seconds form
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  // HTTP-date form (e.g. "Wed, 21 Oct 2026 07:28:00 GMT")
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

/** Exponential backoff with full jitter; prevents synchronized retry stampedes. */
function backoffDelay(attempt: number): number {
  const base = 1000 * 2 ** attempt;
  return Math.floor(base * (0.5 + Math.random() * 0.5));
}

async function fetchRetry(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  limiter: TokenBucket,
  name: string,
  maxRetries = 2,
): Promise<TimedResponse> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await limiter.acquire();
    try {
      const { res, clearTimer } = await fetchTimeout(url, init, timeoutMs);
      if (RETRYABLE.includes(res.status) && attempt < maxRetries) {
        clearTimer();
        await res.body?.cancel().catch(() => {});
        const retryAfterMs = parseRetryAfter(res.headers.get("Retry-After"));
        const delay = Math.min(retryAfterMs ?? backoffDelay(attempt), MAX_RETRY_DELAY_MS);
        console.error(`${name}: HTTP ${res.status}, retry in ${delay}ms (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return { res, clearTimer };
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries) {
        const delay = backoffDelay(attempt);
        console.error(`${name}: ${lastErr.message}, retry in ${delay}ms (${attempt + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr ?? new Error("Request failed");
}

/** Truncate body text to a manageable size for inclusion in error messages. */
function truncateBody(body: string, max = 300): string {
  if (body.length <= max) return body;
  return body.slice(0, max) + `… (truncated, ${body.length} chars total)`;
}

// ─── URL building ──────────────────────────────────────────────────────

/**
 * Serialize params into `key=value` query fragments.
 * Supports string, number, and string[] (repeated keys, e.g. `facets[series][]`).
 * Keys are NOT encoded — preserves bracket syntax like `page[number]`.
 */
function serializeParams(params?: Params): string[] {
  if (!params) return [];
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) parts.push(`${k}=${encodeURIComponent(String(item))}`);
    } else {
      parts.push(`${k}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts;
}

/** Join a base URL, path, and pre-built query fragments into a full URL. */
function joinUrl(baseUrl: string, path: string, parts: string[]): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return parts.length ? `${baseUrl}${p}?${parts.join("&")}` : `${baseUrl}${p}`;
}

// ─── Client Factory ──────────────────────────────────────────────────

export function createClient(config: ClientConfig): ApiClient {
  const {
    baseUrl, name, auth, defaultHeaders = {},
    cacheTtlMs = 5 * 60 * 1000,
    timeoutMs = 30_000,
    maxRetries: configMaxRetries = 2,
    checkError,
  } = config;

  const rl = config.rateLimit ?? { perSecond: 5, burst: 10 };
  const limiter = new TokenBucket(rl.burst, rl.perSecond);
  const cache = new DiskCache(cacheTtlMs, name);

  /** Resolve all env-backed auth params. Returns empty record if none are set. */
  function resolveAuthParams(): Record<string, string> {
    if (!auth) return {};
    const resolved: Record<string, string> = {};
    const entries = Object.entries(auth.envParams);
    for (let i = 0; i < entries.length; i++) {
      const [paramName, envVar] = entries[i];
      const val = process.env[envVar];
      if (!val) continue;
      // Apply prefix to the first entry only (e.g. "Bearer " for Authorization header)
      resolved[paramName] = (i === 0 && auth.prefix ? auth.prefix : "") + val;
    }
    return resolved;
  }

  /** True if all required auth credentials are available in env. */
  function hasAuth(): boolean {
    if (!auth) return false;
    return Object.values(auth.envParams).every((ev) => !!process.env[ev]);
  }

  function buildUrl(path: string, params?: Params): string {
    const parts: string[] = [];

    // Auth via query param
    if (auth?.type === "query") {
      for (const [k, v] of Object.entries(resolveAuthParams())) {
        parts.push(`${k}=${encodeURIComponent(v)}`);
      }
      if (auth.extraParams) {
        for (const [k, v] of Object.entries(auth.extraParams)) parts.push(`${k}=${encodeURIComponent(v)}`);
      }
    }

    parts.push(...serializeParams(params));
    return joinUrl(baseUrl, path, parts);
  }

  /**
   * Same shape as `buildUrl`, but WITHOUT auth params — used only to derive
   * the disk cache key, never sent over the network. `buildUrl`'s output
   * (which does carry the API key/token) must never be used as a cache key:
   * `cache.json` is written to disk namespaced by module name and would
   * otherwise persist secrets in plaintext.
   */
  function buildCacheKeyUrl(path: string, params?: Params): string {
    return joinUrl(baseUrl, path, serializeParams(params));
  }

  function buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { ...defaultHeaders, ...extra };
    if (auth?.type === "header") {
      Object.assign(h, resolveAuthParams());
    }
    return h;
  }

  async function request<T>(
    url: string,
    cacheKey: string,
    init?: RequestInit,
    responseType: "json" | "text" = "json",
  ): Promise<T> {
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached as T;

    const { res, clearTimer } = await fetchRetry(url, init, timeoutMs, limiter, name, configMaxRetries);
    try {
      if (!res.ok) {
        const body = await readBodyCapped(res, MAX_RESPONSE_BYTES);

        // Friendly error for auth failures when no credentials are configured
        if ((res.status === 401 || res.status === 403) && auth && !hasAuth()) {
          const envVars = Object.values(auth.envParams).join(", ");
          throw new Error(
            `${name}: API key required (HTTP ${res.status}). ` +
            `Set the ${envVars} environment variable(s) in your .env file or MCP config.`,
          );
        }

        throw new Error(`${name}: HTTP ${res.status} — ${truncateBody(body || res.statusText)}`);
      }

      if (responseType === "text") {
        const text = await readBodyCapped(res, MAX_RESPONSE_BYTES);
        cache.set(cacheKey, text);
        return text as T;
      }

      const bodyText = await readBodyCapped(res, MAX_RESPONSE_BYTES);
      const data = JSON.parse(bodyText);

      // Check for API-level errors in body
      if (checkError) {
        const err = checkError(data);
        if (err) throw new Error(`${name}: ${err}`);
      }

      cache.set(cacheKey, data);
      return data as T;
    } finally {
      // Only released once the body is fully consumed (or the read itself
      // aborts) — the deadline must cover the whole request, not just
      // headers. See fetchTimeout.
      clearTimer();
    }
  }

  return {
    async get<T = unknown>(path: string, params?: Params): Promise<T> {
      const url = buildUrl(path, params);
      const cacheKey = `${buildCacheKeyUrl(path, params)}||json`;
      const headers = buildHeaders();
      return request<T>(url, cacheKey, Object.keys(headers).length ? { headers } : undefined);
    },

    async getText(path: string, params?: Params): Promise<string> {
      const url = buildUrl(path, params);
      const cacheKey = `${buildCacheKeyUrl(path, params)}||text`;
      const headers = buildHeaders();
      return request<string>(url, cacheKey, Object.keys(headers).length ? { headers } : undefined, "text");
    },

    async post<T = unknown>(
      path: string,
      body?: Record<string, unknown>,
      params?: Params,
    ): Promise<T> {
      const url = buildUrl(path, params);
      // Cache key uses the caller-supplied body only — not `finalBody` below,
      // which may have auth credentials merged in for body-based auth (e.g. BLS).
      const cacheKey = `${buildCacheKeyUrl(path, params)}|${JSON.stringify(body ?? {})}|json`;
      const headers = buildHeaders({ "Content-Type": "application/json" });

      // Auth via body (e.g. BLS)
      const finalBody = { ...body };
      if (auth?.type === "body") {
        const resolved = resolveAuthParams();
        if (Object.keys(resolved).length) {
          Object.assign(finalBody, resolved);
          if (auth.extraParams) Object.assign(finalBody, auth.extraParams);
        }
      }

      return request<T>(url, cacheKey, {
        method: "POST",
        headers,
        body: JSON.stringify(finalBody),
      });
    },

    clearCache() { cache.clear(); },
  };
}
