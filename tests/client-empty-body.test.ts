/**
 * Root cause of the reported `census_population` failure ("Unexpected end of
 * JSON input"): several upstream government APIs answer a request that
 * matches zero rows with HTTP 200 or 204 and a genuinely empty body — Census
 * does this for an unrecognized `for=` geography (e.g. a state name instead
 * of a FIPS code) instead of returning a 4xx. `request()` only special-cased
 * non-OK responses; a 2xx response went straight to `JSON.parse(bodyText)`,
 * and `JSON.parse("")` throws `SyntaxError: Unexpected end of JSON input` —
 * a cryptic parser error instead of a usable result.
 *
 * The fix treats an empty body on a 2xx response as `{}` rather than parsing
 * it. That's a safe stand-in across the codebase: every module's `res.foo ??
 * []`-style access already tolerates a missing key, and the handful of
 * modules expecting a top-level array (census, world-bank, dol, ...) already
 * guard with `Array.isArray(data)`, which correctly rejects `{}` and falls
 * through to their own friendly "no data" message.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createClient } from "../src/shared/client.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function stubFetch(status: number, body: string): void {
  // The Fetch spec forbids a non-null body on a null-body status (204/205/304);
  // Node's Response constructor enforces that, so an "empty body" response
  // must be constructed with `null`, not `""`, when the status requires it.
  const nullBodyStatus = status === 204 || status === 205 || status === 304;
  global.fetch = (async () => new Response(nullBodyStatus ? null : body, { status })) as unknown as typeof fetch;
}

describe("createClient: empty-body 2xx responses", () => {
  it("returns {} instead of throwing on 200 OK with an empty body", async () => {
    stubFetch(200, "");
    const client = createClient({ baseUrl: "https://example.test", name: "test-empty-200", cacheTtlMs: 0 });
    await expect(client.get("/x")).resolves.toEqual({});
  });

  it("returns {} instead of throwing on 204 No Content", async () => {
    stubFetch(204, "");
    const client = createClient({ baseUrl: "https://example.test", name: "test-empty-204", cacheTtlMs: 0 });
    await expect(client.get("/x")).resolves.toEqual({});
  });

  it("still parses a normal JSON body unchanged", async () => {
    stubFetch(200, JSON.stringify({ a: 1 }));
    const client = createClient({ baseUrl: "https://example.test", name: "test-normal-body", cacheTtlMs: 0 });
    await expect(client.get("/x")).resolves.toEqual({ a: 1 });
  });

  it("an empty-array response still parses as an empty array, not {}", async () => {
    stubFetch(200, "[]");
    const client = createClient({ baseUrl: "https://example.test", name: "test-empty-array", cacheTtlMs: 0 });
    await expect(client.get("/x")).resolves.toEqual([]);
  });

  it("a whitespace-only body is also treated as empty", async () => {
    stubFetch(200, "   \n  ");
    const client = createClient({ baseUrl: "https://example.test", name: "test-whitespace-body", cacheTtlMs: 0 });
    await expect(client.get("/x")).resolves.toEqual({});
  });

  it("still throws with a clear message for a genuinely malformed non-empty body", async () => {
    stubFetch(200, "<html>not json</html>");
    const client = createClient({ baseUrl: "https://example.test", name: "test-malformed-body", cacheTtlMs: 0 });
    await expect(client.get("/x")).rejects.toThrow();
  });
});
