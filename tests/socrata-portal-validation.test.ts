/**
 * Socrata portal validation — `domain` is caller-supplied (LLM/user-driven)
 * and flows directly into a server-side fetch(), unlike every other module's
 * fixed baseUrl. assertPortal() is the only thing standing between that input
 * and an SSRF-shaped request, so it gets its own focused test file.
 */

import { describe, it, expect } from "vitest";
import { assertPortal, soqlEscape } from "../src/apis/socrata/sdk.js";

describe("socrata: assertPortal", () => {
  it.each([
    "data.ny.gov",
    "data.texas.gov",
    "opendata.maryland.gov",
    "data.cityofnewyork.us",
    "DATA.NY.GOV", // case-insensitive
    "https://data.ny.gov", // strips scheme
    "data.ny.gov/resource/abcd.json", // strips path
    "data.ny.gov:22", // port is stripped — the client always issues https on the default port anyway
  ])("accepts %s", (input) => {
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
  ])("rejects %s", (input) => {
    expect(() => assertPortal(input)).toThrow();
  });

  it("normalizes scheme, path, port, and case", () => {
    expect(assertPortal("HTTPS://Data.NY.gov/resource/xyz.json")).toBe("data.ny.gov");
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
