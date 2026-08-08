# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP server + standalone TypeScript SDK exposing 40+ U.S. government (and a few international) open-data APIs as ~300 MCP tools, built on `fastmcp`. Every API integration lives in its own self-contained folder under `src/apis/` and is auto-discovered at server startup — adding a new government data source never requires touching the server or wiring code, with one exception (see "The SDK barrel is NOT auto-discovered" below).

## Commands

```bash
npx tsc              # build (outputs to dist/, strict mode, ES2022/Node16 modules)
npm run dev           # tsc --watch
npm test              # vitest run — full suite
npm run test:watch    # vitest watch mode
npx vitest run tests/module-structure.test.ts   # run a single test file
npx vitest run -t "exports domains"             # run tests matching a name pattern

node dist/server.js                             # start MCP server (stdio)
node dist/server.js --list-modules              # list all discovered modules + tool counts
node dist/server.js --list-modules --json       # same, machine-readable
node dist/server.js --modules fred,bls,treasury # load only specific modules (faster startup)
node dist/server.js --transport httpStream --port 8080  # HTTP transport instead of stdio (requires MCP_AUTH_TOKEN — see below)

npm run docs:generate   # regenerate docs/*.md from dist/apis (must build first)
npm run docs:dev        # generate + serve vitepress docs locally
```

There is no lint step (no ESLint config); CI (`.github/workflows/ci.yml`) only runs `npm run build` and `npm test` on Node 20/22. `tests/**/*.smoke.test.ts` files are excluded from the default `vitest.config.ts` run (none currently exist, but that's the convention for anything that hits live network endpoints instead of pure logic).

## Architecture

### stdio vs. httpStream have different trust models

stdio (the default — Claude Desktop/VS Code/Cursor) is a local pipe to one trusted client; no auth needed. httpStream is a network listener, and this server holds live API keys for ~40 upstream services, so it **fails closed**: `resolveAuthConfig` (`src/server/auth.ts`) validates every auth env var at startup and `server.ts` `process.exit(1)`s if no usable credential is configured. It never falls back to unauthenticated. All problems are printed at once rather than one per boot, because each redeploy cycle costs minutes.

Two credential types, and both can be active simultaneously (`MCP_AUTH_MODE` = `static` | `oauth` | `both`):

- **Static shared token** (`MCP_AUTH_TOKEN`) — `Authorization: Bearer <token>`, compared via SHA-256 + `timingSafeEqual` (hashing first keeps the compared buffers a fixed 32 bytes, so no length is leaked and `timingSafeEqual` can't throw). Minimum 32 chars; blank/short/placeholder values are fatal, not warnings. `?token=` is only read when `MCP_ALLOW_QUERY_TOKEN` is set, since query strings leak into access logs.
- **Microsoft Entra ID OAuth** (`AZURE_CLIENT_ID`/`AZURE_CLIENT_SECRET`/`AZURE_TENANT_ID` + `MCP_PUBLIC_URL`) — see `docs/guide/oauth-azure.md`.

`/health` is intentionally exempt (for platform health checks). The Dockerfile sets `MCP_TRANSPORT=httpStream` + `MCP_HOST=0.0.0.0` for container deployment (e.g. Railway) — `PORT`/`MCP_PORT`/`--port` are all honored, in that precedence order, and `SIGTERM`/`SIGINT` trigger a clean `server.stop()`.

**The authenticator must throw, never return `undefined`.** fastmcp's stateful `createServer` path does not null-check the auth result before creating a session, so returning `undefined` (which `AuthProvider.authenticate` does on every failure) would leave `GET /sse` — and the `POST /messages?sessionId=` that follows — reachable with no credential at all. `createAuthenticator` throws a `Response`; `tests/auth.test.ts` pins this explicitly.

### fastmcp's OAuth routes are unsafe as shipped — we shadow two of them

Passing `auth: <provider>` makes fastmcp register `/oauth/*` and `/.well-known/*` outside the authenticate gate. Two of those routes are exploitable in 3.35.0, so `src/server/oauth-routes.ts` replaces them via `server.getApp()` (fastmcp calls `honoApp.fetch()` first and returns on any non-404, so Hono routes win):

- `POST /oauth/register` returns the **upstream** app's `client_secret` — i.e. one anonymous curl retrieves your Entra client ID and secret. Our handler strips it and advertises `token_endpoint_auth_method: "none"`, which is safe because the proxy's `exchangeAuthorizationCode` never checks the secret (only `client_id` + PKCE).
- `GET /oauth/authorize` never validates `redirect_uri` against anything and treats PKCE as optional, so a crafted link can deliver a live authorization code to an attacker's host. Our handler enforces an exact allowlist and requires `S256` PKCE.

Do **not** try to fix these by configuring `allowedRedirectUriPatterns`: that check falls open (returns true for any `https:` URI when no pattern matches), and its matcher builds a RegExp without escaping, so `.` acts as a wildcard. Redirect restriction has to live in our handlers. `tests/oauth-guards.test.ts` covers both, using a stub proxy that deliberately mimics the unsafe behavior so the tests prove *our* guard blocks it.

### Module = folder, auto-discovered by the server

`src/server.ts` does `readdirSync(src/apis)` and dynamically imports `./apis/{dir}/index.js` for every subfolder. Each module's `index.ts` default-exports an object satisfying `ApiModule` (`src/shared/types.ts`). The required shape per module folder (enforced by `tests/module-structure.test.ts`, which iterates every folder generically):

```
src/apis/{name}/
  sdk.ts     # typed API client — zero MCP/Zod dependency, usable standalone
  meta.ts    # name, displayName, category, description, auth?, workflow, tips, domains, crossRef?, reference?
  tools.ts   # MCP tool definitions (zod schemas + execute fns), imports from sdk.ts
  index.ts   # export default { ...meta, tools, clearCache } satisfies ApiModule
  prompts.ts # optional MCP prompts
```

Full walkthrough: `docs/guide/adding-modules.md`.

### The SDK barrel is NOT auto-discovered — this is the one manual step

`src/apis/index.ts` is a hand-maintained barrel (`export * as fred from "./fred/sdk.js"`, etc.) that lets the npm package be used as a plain TypeScript SDK without MCP (`import { getObservations } from "us-gov-open-data-mcp/sdk/fred"`). It is NOT read by the server at runtime — only `tests/sdk-barrel.test.ts` enforces that every folder under `src/apis/` has a matching entry (kebab-case folder → camelCase export key, e.g. `epa-aqs` → `epaAqs`). **New modules must be added here by hand or the test suite fails**, even though the MCP server itself needs no such wiring.

### `createClient()` is the shared HTTP layer (`src/shared/client.ts`)

Every SDK calls `createClient({ baseUrl, name, auth?, rateLimit?, cacheTtlMs?, checkError? })` once at module load and gets back a `{ get, getText, post, clearCache }` client with:
- Disk-backed TTL cache (`~/.cache/us-gov-open-data-mcp/cache.json`, namespaced by the client's `name`), survives process restarts
- Token-bucket rate limiting per client
- Retry with full-jitter exponential backoff on 429/502/503/504, honoring `Retry-After` (capped at 30s — an upstream can't hang a request for a day by sending a huge value)
- Three auth injection styles: `query` (param), `header` (with optional prefix, e.g. `Bearer `), `body` (POST). Auth is resolved from env vars at request time and silently omitted if unset — tools still get registered, they just fail with a clear "API key required" error at call time (see `server.ts` startup validation, which only warns, never blocks loading)
- The request timeout covers the whole request, not just until headers arrive — the `AbortController` stays live through body consumption (`readBodyCapped`, also capped at 50MB), otherwise a stalled body could hang past the nominal `timeoutMs`
- The on-disk cache key is derived separately from the request URL/body (`buildCacheKeyUrl`, the caller-supplied `body` before auth injection) specifically so query/header/body-injected credentials never end up written into `cache.json`
- The rate limiter's wait queue (`TokenBucket`) is capped (`MAX_QUEUE_LENGTH`) so a burst far exceeding the configured rate fails fast instead of accumulating unbounded pending promises

`baseUrl` is fixed at `createClient()` call time — this assumes one module = one fixed API host. The `socrata` module is the exception: it's a multi-tenant platform (each state/city runs its own portal), so it memoizes a `Map<domain, ApiClient>` and validates caller-supplied hostnames (`assertPortal` in `src/apis/socrata/sdk.ts`) before ever calling `createClient` with them, since an unvalidated hostname flowing into `fetch()` from tool input is an SSRF vector. `assertPortal` defaults to a curated allowlist (`STATE_PORTALS`/`CITY_PORTALS`/`FEDERAL_PORTALS`) — a plain hostname denylist isn't sufficient here (it misses whole private ranges, non-IP internal hosts, and encoded IP literals like octal `0177.0.0.1` == `127.0.0.1`). `SOCRATA_ALLOW_ANY_PORTAL=true` opts into reaching portals outside the curated list (with those private-range checks still applied), but `SOCRATA_APP_TOKEN` is only ever attached to a curated (`isKnownPortal`) host — never to a caller-supplied one — so an unlisted/opted-in portal can't exfiltrate the credential. Any future module that talks to a variable/multi-tenant host should follow that pattern (allowlist + no-credential-to-unknown-host) rather than adding dynamic-host support to the shared client.

### `meta.ts` feeds the LLM-facing instructions, not just docs

`src/server/instructions.ts` builds the entire MCP `instructions` string sent to the client from module metadata: one block per module (`displayName`, `description`, tool names, `workflow`, `tips`, auth requirement), followed by an auto-generated cross-reference routing table built from every module's `crossRef` hints, grouped by `QuestionType` (see `src/shared/types.ts` for the fixed `DOMAINS` and `QUESTION_TYPES` unions — both are closed sets checked at compile time and by `module-structure.test.ts`). Getting `crossRef` right (specific tool/param names, not vague topic words) directly changes how well the LLM routes multi-source questions — it's not just documentation metadata.

### Response shaping (`src/shared/response.ts`)

Tools never return raw API JSON. They call one of `timeseriesResponse` (date+value data, auto-computes min/max/mean/trend), `tableResponse` (tabular, converts to columnar `{columns, rows}` to save tokens vs. repeating keys per row), `recordResponse` (single object, strips nulls), `listResponse` (search results), or `emptyResponse`. All return `JSON.stringify(...)` strings — tools should not hand-roll response envelopes.

### `code_mode` (in `server.ts`) — WASM sandbox for large tool outputs

A generic tool that calls any other registered tool, then runs LLM-authored JS against the raw response in a QuickJS WASM sandbox (`src/shared/sandbox.ts`, no filesystem/network access, 10s timeout, 64MB memory cap) and returns only `console.log` output. Exists to let the LLM filter/aggregate huge responses without paying full context cost. If you add a tool that can return very large payloads, no special handling is needed on your end — `code_mode` composes with any tool via its name.

`code_mode` calls the target tool's `execute()` directly rather than going through FastMCP's normal `CallToolRequestSchema` handler, so it validates `tool_args` against that tool's own Standard-Schema/Zod `parameters` itself (`"~standard".validate`) before calling `execute` — skipping this would let `tool_args` bypass every tool's own enum/bound/format constraints.

The sandbox's `setMemoryLimit(64MB)` only bounds QuickJS's own WASM heap — the `stdout` string built up in the `console.log` callback lives on the **host's** Node heap and is a separate, unbounded surface unless capped there too. `sandbox.ts` caps host-side stdout at 256KB (halting the script via the interrupt handler once hit, not just discarding output) and limits concurrent sandbox executions to 3, since each one reserves up to 64MB + 10MB of `DATA` and unbounded concurrency (e.g. behind the HTTP transport) can exhaust host memory independent of any single execution's own limits.

### Testing model

`tests/helpers.ts` uses Vite's `import.meta.glob` to eagerly import every `src/apis/*/index.ts` and drives all the generic per-module checks in `tests/module-structure.test.ts` (required fields, snake_case tool names, valid `domains`/`crossRef` question types, annotation shape, no duplicate tool names within or across modules). Adding a module means these tests exercise it automatically — no per-module test file needed unless the module has bespoke logic worth unit-testing directly (e.g. `tests/socrata-portal-validation.test.ts` tests `assertPortal`'s SSRF guard — including regression cases for previously-confirmed bypasses like `172.16.0.0/12` and octal/hex-encoded IP literals — since that's logic no generic structural test could catch; `tests/sandbox-security.test.ts` similarly covers `code_mode`'s host-side stdout cap and concurrency limit, not just the sandbox's own WASM memory/timeout limits).

`server.ts` itself still has no unit tests — it's a top-level script with side effects (module discovery via `readdirSync`/dynamic `import()`, `process.argv` parsing, `server.start()`, `process.exit`), not a set of pure functions. That's why the auth *decisions* were extracted into `src/server/auth.ts` and `src/server/oauth-routes.ts`, which are covered by `tests/auth.test.ts` and `tests/oauth-guards.test.ts`: `resolveAuthConfig` takes `env` as a plain object rather than reading `process.env`, and the guards are exercised against a real Hono app with a stub proxy. Neither uses `vi.mock` — the OAuth delegate and proxy are hand-written objects satisfying an interface, consistent with the repo's no-mocking convention.

What those tests do **not** cover, and which still needs `curl` against a running `dist/server.js`: that the Hono guard routes actually shadow fastmcp's built-in ones (route precedence is a runtime property of fastmcp's request handler), `/health`, `PORT`, `SIGTERM`, and the real Microsoft handshake (which needs a live tenant). Don't assume CI proves the httpStream path end-to-end.
