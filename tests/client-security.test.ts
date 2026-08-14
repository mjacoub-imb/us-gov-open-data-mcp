/**
 * Two hardening gaps found in `src/shared/client.ts`'s response handling:
 *
 * 1. `readBodyCapped` only enforces its byte cap on the streaming path
 *    (`res.body?.getReader()`). If a response has no readable body stream,
 *    it silently falls back to unbounded `res.text()` — defeating the
 *    documented "guards against an unbounded body" purpose for that case.
 *
 * 2. The on-disk cache key deliberately excludes auth credentials (so
 *    secrets never land in cache.json — see `buildCacheKeyUrl`), but that
 *    means rotating an API key doesn't change the cache key: a response
 *    fetched under the old credential keeps being served after rotation.
 *    `authCacheFingerprint` closes that gap by folding a one-way hash of
 *    the resolved credential into the key, without ever storing the raw
 *    value.
 *
 * 3. `path` is a tagged-template helper that URI-encodes every interpolated
 *    segment automatically. Several SDKs across the codebase wrap each
 *    caller-supplied path segment in `encodeURIComponent(...)` by hand at
 *    the call site — easy to get right once, easy to forget on the next
 *    endpoint added to the same file. Centralizing it here means a new
 *    call site can't skip the encoding step even by accident.
 */

import { describe, it, expect } from "vitest";
import { authCacheFingerprint, path, readBodyCapped } from "../src/shared/client.js";

describe("readBodyCapped: fallback path when a response has no readable body stream", () => {
  it("throws once the buffered text exceeds the cap", async () => {
    const res = { body: null, text: async () => "x".repeat(101) } as unknown as Response;
    await expect(readBodyCapped(res, 100)).rejects.toThrow(/exceeded/i);
  });

  it("returns the text unchanged when within the cap", async () => {
    const res = { body: null, text: async () => "ok" } as unknown as Response;
    await expect(readBodyCapped(res, 100)).resolves.toBe("ok");
  });
});

describe("authCacheFingerprint", () => {
  it("differs when the resolved credential value differs", () => {
    const a = authCacheFingerprint({ api_key: "key-one" });
    const b = authCacheFingerprint({ api_key: "key-two" });
    expect(a).not.toBe(b);
  });

  it("is empty for a module with no resolved auth params", () => {
    expect(authCacheFingerprint({})).toBe("");
  });

  it("never contains the raw credential value verbatim", () => {
    const secret = "super-secret-api-key-value-123";
    const fp = authCacheFingerprint({ api_key: secret });
    expect(fp).not.toContain(secret);
  });

  it("is deterministic for the same input", () => {
    expect(authCacheFingerprint({ api_key: "key-one" })).toBe(authCacheFingerprint({ api_key: "key-one" }));
  });
});

describe("path", () => {
  it("leaves literal segments untouched", () => {
    expect(path`/agency/byStateAbbr/CA`).toBe("/agency/byStateAbbr/CA");
  });

  it("encodes an interpolated segment", () => {
    const id = "some id/with?special&chars";
    expect(path`/filings/${id}/`).toBe(`/filings/${encodeURIComponent(id)}/`);
  });

  it("encodes a caller-supplied '../' attempt rather than letting it traverse the path", () => {
    const evil = "../../secret";
    expect(path`/resource/${evil}.json`).toBe(`/resource/${encodeURIComponent(evil)}.json`);
    expect(path`/resource/${evil}.json`).not.toContain("../");
  });

  it("encodes multiple interpolated segments independently", () => {
    expect(path`/uof/reports/${"a b"}/${"c/d"}`).toBe(`/uof/reports/${encodeURIComponent("a b")}/${encodeURIComponent("c/d")}`);
  });

  it("stringifies a numeric segment before encoding", () => {
    expect(path`/vote/${42}`).toBe("/vote/42");
  });
});
