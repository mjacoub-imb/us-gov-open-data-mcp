/**
 * Socrata portal validation — `domain` is caller-supplied (LLM/user-driven)
 * and flows directly into a server-side fetch() carrying SOCRATA_APP_TOKEN,
 * unlike every other module's fixed baseUrl. assertPortal() is the only
 * thing standing between that input and an SSRF-shaped (and
 * credential-exfiltrating) request, so it gets its own focused test file.
 *
 * Default behavior is an allowlist: only STATE_PORTALS/CITY_PORTALS/
 * FEDERAL_PORTALS are accepted. SOCRATA_ALLOW_ANY_PORTAL=true opts into a
 * broader private-range/reserved-hostname denylist for anything else, and
 * `isKnownPortal` gates whether SOCRATA_APP_TOKEN is ever attached.
 *
 * process.env.SOCRATA_ALLOW_ANY_PORTAL is read per-call (not cached at
 * import), so tests can toggle it directly without resetting modules.
 */

import { describe, it, expect, afterEach } from "vitest";
import { assertPortal, isKnownPortal, soqlEscape } from "../src/apis/socrata/sdk.js";

afterEach(() => {
  delete process.env.SOCRATA_ALLOW_ANY_PORTAL;
});

describe("socrata: assertPortal (default — curated allowlist only)", () => {
  it.each([
    "data.ny.gov",
    "data.texas.gov",
    "opendata.maryland.gov",
    "data.cityofnewyork.us",
    "DATA.NY.GOV", // case-insensitive
    "https://data.ny.gov", // strips scheme
    "data.ny.gov/resource/abcd.json", // strips path
    "data.ny.gov:22", // port is stripped — the client always issues https on the default port anyway
  ])("accepts known portal %s", (input) => {
    expect(() => assertPortal(input)).not.toThrow();
  });

  it.each([
    "localhost",
    "127.0.0.1",
    "127.0.0.1:8080",
    "10.0.0.5",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata endpoint
    "0.0.0.0",
    "user@data.ny.gov",
    "data.ny.gov@evil.com",
    "not a hostname",
    "",
    // Not on the curated allowlist — rejected by default even though these
    // are well-formed public hostnames, not because they look unsafe.
    "attacker-controlled.example.com",
    "data.arizona.gov",
  ])("rejects %s", (input) => {
    expect(() => assertPortal(input)).toThrow();
  });

  it("normalizes scheme, path, port, and case", () => {
    expect(assertPortal("HTTPS://Data.NY.gov/resource/xyz.json")).toBe("data.ny.gov");
  });

  it("only known/curated portals get the app token attached", () => {
    expect(isKnownPortal("data.ny.gov")).toBe(true);
    expect(isKnownPortal("attacker-controlled.example.com")).toBe(false);
  });
});

describe("socrata: assertPortal bypass regressions (SOCRATA_ALLOW_ANY_PORTAL=true)", () => {
  // These four hostname classes previously slipped past the old string-prefix
  // denylist (["localhost", "127.", "10.", "192.168.", "169.254.", "0."])
  // even outside the curated list. Confirmed against the pre-fix build:
  //   ALLOWED : postgres.railway.internal
  //   ALLOWED : metadata.google.internal
  //   ALLOWED : 172.17.0.1        (172.16.0.0/12 wasn't covered by "10."/"192.168.")
  //   ALLOWED : 0177.0.0.1        (octal for 127.0.0.1 — inet_aton resolves it that way)
  it.each([
    "postgres.railway.internal",
    "metadata.google.internal",
    "some-host.local",
    "172.16.0.1",
    "172.31.255.255",
    "0177.0.0.1", // octal 127.0.0.1
    "0x7f.0.0.1", // hex 127.0.0.1
  ])("still rejects %s even when opted in", (input) => {
    process.env.SOCRATA_ALLOW_ANY_PORTAL = "true";
    expect(() => assertPortal(input)).toThrow();
  });

  it("allows a well-formed public hostname outside the curated list when opted in", () => {
    process.env.SOCRATA_ALLOW_ANY_PORTAL = "true";
    expect(assertPortal("data.arizona.gov")).toBe("data.arizona.gov");
  });

  it("never marks an opted-in, non-curated portal as a known (token-bearing) portal", () => {
    process.env.SOCRATA_ALLOW_ANY_PORTAL = "true";
    const d = assertPortal("data.arizona.gov");
    expect(isKnownPortal(d)).toBe(false);
  });

  it("rejects non-curated portals by default even without the opt-in", () => {
    expect(() => assertPortal("data.arizona.gov")).toThrow();
  });
});

describe("socrata: soqlEscape", () => {
  it("doubles single quotes", () => {
    expect(soqlEscape("O'Brien")).toBe("O''Brien");
  });

  it("passes through strings without quotes", () => {
    expect(soqlEscape("New York")).toBe("New York");
  });

  it("stringifies numbers", () => {
    expect(soqlEscape(2023)).toBe("2023");
  });
});
