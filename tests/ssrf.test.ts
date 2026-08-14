/**
 * Direct unit tests for src/shared/ssrf.ts — the hostname-validation helpers
 * extracted from socrata/sdk.ts so a future module with a caller-supplied,
 * variable/multi-tenant host (per CLAUDE.md's guidance) can reuse them
 * instead of reimplementing SSRF checks from scratch. Full behavioral
 * coverage of the SSRF guard (as applied to a real module) lives in
 * tests/socrata-portal-validation.test.ts; this file just pins the shared
 * module's own contract in isolation.
 */

import { describe, it, expect } from "vitest";
import { isPrivateOrReservedHost, normalizeHostname, parseIPv4Literal } from "../src/shared/ssrf.js";

describe("normalizeHostname", () => {
  it("strips scheme, path, port, and lowercases", () => {
    expect(normalizeHostname("HTTPS://Example.COM:8080/path", { label: "test", noun: "hostname", example: "example.com" }))
      .toBe("example.com");
  });

  it("throws using the caller's own label/noun/example", () => {
    expect(() => normalizeHostname("not a hostname", { label: "widgets", noun: "widget host", example: "widgets.example" }))
      .toThrow(/widgets: "not a hostname" doesn't look like a valid widget host \(expected e\.g\. "widgets\.example"\)/);
  });
});

describe("parseIPv4Literal", () => {
  it("parses a standard 4-label dotted quad", () => {
    expect(parseIPv4Literal("192.168.1.1")).toEqual([192, 168, 1, 1]);
  });

  it("parses shorthand forms per inet_aton semantics", () => {
    expect(parseIPv4Literal("127.1")).toEqual([127, 0, 0, 1]);
  });

  it("returns null for a non-IP hostname", () => {
    expect(parseIPv4Literal("data.ny.gov")).toBeNull();
  });
});

describe("isPrivateOrReservedHost", () => {
  it.each(["localhost", "foo.local", "foo.internal", "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.0.1", "169.254.169.254"])(
    "flags %s as private/reserved",
    (host) => {
      expect(isPrivateOrReservedHost(host)).toBe(true);
    },
  );

  it("does not flag a public hostname", () => {
    expect(isPrivateOrReservedHost("data.ny.gov")).toBe(false);
  });
});
