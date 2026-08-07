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
node dist/server.js --transport httpStream --port 8080  # HTTP transport instead of stdio

npm run docs:generate   # regenerate docs/*.md from dist/apis (must build first)
npm run docs:dev        # generate + serve vitepress docs locally
```

There is no lint step (no ESLint config); CI (`.github/workflows/ci.yml`) only runs `npm run build` and `npm test` on Node 20/22. `tests/**/*.smoke.test.ts` files are excluded from the default `vitest.config.ts` run (none currently exist, but that's the convention for anything that hits live network endpoints instead of pure logic).

## Architecture

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
- Retry with full-jitter exponential backoff on 429/502/503/504, honoring `Retry-After`
- Three auth injection styles: `query` (param), `header` (with optional prefix, e.g. `Bearer `), `body` (POST). Auth is resolved from env vars at request time and silently omitted if unset — tools still get registered, they just fail with a clear "API key required" error at call time (see `server.ts` startup validation, which only warns, never blocks loading)

`baseUrl` is fixed at `createClient()` call time — this assumes one module = one fixed API host. The `socrata` module is the exception: it's a multi-tenant platform (each state/city runs its own portal), so it memoizes a `Map<domain, ApiClient>` and validates caller-supplied hostnames (`assertPortal` in `src/apis/socrata/sdk.ts`) before ever calling `createClient` with them, since an unvalidated hostname flowing into `fetch()` from tool input is an SSRF vector. Any future module that talks to a variable/multi-tenant host should follow that pattern rather than adding dynamic-host support to the shared client.

### `meta.ts` feeds the LLM-facing instructions, not just docs

`src/server/instructions.ts` builds the entire MCP `instructions` string sent to the client from module metadata: one block per module (`displayName`, `description`, tool names, `workflow`, `tips`, auth requirement), followed by an auto-generated cross-reference routing table built from every module's `crossRef` hints, grouped by `QuestionType` (see `src/shared/types.ts` for the fixed `DOMAINS` and `QUESTION_TYPES` unions — both are closed sets checked at compile time and by `module-structure.test.ts`). Getting `crossRef` right (specific tool/param names, not vague topic words) directly changes how well the LLM routes multi-source questions — it's not just documentation metadata.

### Response shaping (`src/shared/response.ts`)

Tools never return raw API JSON. They call one of `timeseriesResponse` (date+value data, auto-computes min/max/mean/trend), `tableResponse` (tabular, converts to columnar `{columns, rows}` to save tokens vs. repeating keys per row), `recordResponse` (single object, strips nulls), `listResponse` (search results), or `emptyResponse`. All return `JSON.stringify(...)` strings — tools should not hand-roll response envelopes.

### `code_mode` (in `server.ts`) — WASM sandbox for large tool outputs

A generic tool that calls any other registered tool, then runs LLM-authored JS against the raw response in a QuickJS WASM sandbox (`src/shared/sandbox.ts`, no filesystem/network access, 10s timeout, 64MB memory cap) and returns only `console.log` output. Exists to let the LLM filter/aggregate huge responses without paying full context cost. If you add a tool that can return very large payloads, no special handling is needed on your end — `code_mode` composes with any tool via its name.

### Testing model

`tests/helpers.ts` uses Vite's `import.meta.glob` to eagerly import every `src/apis/*/index.ts` and drives all the generic per-module checks in `tests/module-structure.test.ts` (required fields, snake_case tool names, valid `domains`/`crossRef` question types, annotation shape, no duplicate tool names within or across modules). Adding a module means these tests exercise it automatically — no per-module test file needed unless the module has bespoke logic worth unit-testing directly (e.g. `tests/socrata-portal-validation.test.ts` tests `assertPortal`'s SSRF guard, since that's logic no generic structural test could catch).
