/**
 * Unit tests for HTTP-transport authentication (`src/server/auth.ts`).
 *
 * These cover the rules that decide whether the server may come up at all
 * and whether a given request gets in. Everything here is pure — `env` is
 * passed as a plain object rather than read from process.env, and the OAuth
 * delegate is a hand-written stub satisfying the `OAuthDelegate` interface
 * (not a mocked module — the repo does not mock I/O anywhere).
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  createAuthenticator,
  extractPresentedToken,
  isAllowedRedirectUri,
  resolveAuthConfig,
  safeTokenEqual,
  validatePublicUrl,
  validateTenantId,
  DEFAULT_REDIRECT_ALLOWLIST,
  MIN_STATIC_TOKEN_LENGTH,
  type AuthEnv,
  type OAuthDelegate,
} from "../src/server/auth.js";

// ─── Helpers ──────────────────────────────────────────────────────────

/** A token that satisfies the length rule, so tests exercise the rule they mean to. */
const GOOD_TOKEN = "a".repeat(MIN_STATIC_TOKEN_LENGTH);
const TENANT_GUID = "11111111-2222-3333-4444-555555555555";

function validOAuthEnv(overrides: AuthEnv = {}): AuthEnv {
  return {
    AZURE_CLIENT_ID: "client-id",
    AZURE_CLIENT_SECRET: "client-secret",
    AZURE_TENANT_ID: TENANT_GUID,
    MCP_PUBLIC_URL: "https://example.up.railway.app",
    ...overrides,
  };
}

/** Minimal IncomingMessage stand-in — only the fields the code reads. */
function req(headers: Record<string, string | string[]> = {}, url = "/mcp"): IncomingMessage {
  return { headers, url } as unknown as IncomingMessage;
}

function errorsOf(result: ReturnType<typeof resolveAuthConfig>): string[] {
  return result.ok ? [] : result.errors;
}

// ─── validateTenantId ─────────────────────────────────────────────────

describe("validateTenantId", () => {
  it("accepts a directory GUID", () => {
    expect(validateTenantId(TENANT_GUID)).toEqual({ value: TENANT_GUID });
  });

  it("accepts a verified domain", () => {
    expect(validateTenantId("contoso.onmicrosoft.com")).toEqual({ value: "contoso.onmicrosoft.com" });
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(validateTenantId(`  ${TENANT_GUID.toUpperCase()}  `)).toEqual({ value: TENANT_GUID });
  });

  // AzureProvider defaults tenantId to "common", which would let any Microsoft
  // account in the world sign in. Case variants must not sneak past.
  it.each(["common", "Common", "COMMON", " organizations ", "consumers"])(
    "rejects the multi-tenant alias %s",
    input => {
      const result = validateTenantId(input);
      expect("error" in result).toBe(true);
      expect((result as { error: string }).error).toMatch(/ANY Microsoft account/i);
    },
  );

  it("rejects a missing value", () => {
    expect("error" in validateTenantId(undefined)).toBe(true);
    expect("error" in validateTenantId("")).toBe(true);
  });

  // The tenant is interpolated into the Microsoft authorize/token URL, so a
  // value carrying userinfo or path separators can redirect the entire OAuth
  // flow to another host.
  it.each([
    "x@evil.example",
    "tenant/../other",
    "tenant?x=1",
    "tenant#frag",
    "tenant with spaces",
    "https://evil.example",
  ])("rejects injection-shaped value %s", input => {
    expect("error" in validateTenantId(input)).toBe(true);
  });
});

// ─── validatePublicUrl ────────────────────────────────────────────────

describe("validatePublicUrl", () => {
  it("accepts a bare https origin", () => {
    expect(validatePublicUrl("https://example.up.railway.app")).toEqual({
      value: "https://example.up.railway.app",
    });
  });

  it("accepts http on loopback for local development", () => {
    expect(validatePublicUrl("http://localhost:8080")).toEqual({ value: "http://localhost:8080" });
  });

  // Entra matches redirect URIs by exact string, so a trailing slash yields
  // "https://host//oauth/callback" and fails at first login, not at startup.
  it("rejects a trailing slash", () => {
    const result = validatePublicUrl("https://example.up.railway.app/");
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/trailing slash or path/i);
  });

  it.each([
    "https://example.up.railway.app/mcp",
    "https://example.up.railway.app?x=1",
    "https://user:pw@example.up.railway.app",
  ])("rejects non-origin URL %s", input => {
    expect("error" in validatePublicUrl(input)).toBe(true);
  });

  it("rejects http on a non-loopback host", () => {
    const result = validatePublicUrl("http://example.up.railway.app");
    expect("error" in result).toBe(true);
    expect((result as { error: string }).error).toMatch(/https/i);
  });

  it("rejects an unparseable value", () => {
    expect("error" in validatePublicUrl("not a url")).toBe(true);
  });

  it("rejects a missing value", () => {
    expect("error" in validatePublicUrl(undefined)).toBe(true);
  });
});

// ─── isAllowedRedirectUri ─────────────────────────────────────────────

describe("isAllowedRedirectUri", () => {
  it("accepts an exact allowlist match", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback", DEFAULT_REDIRECT_ALLOWLIST)).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback", DEFAULT_REDIRECT_ALLOWLIST)).toBe(true);
  });

  it("accepts loopback on any port (local clients bind an ephemeral port)", () => {
    expect(isAllowedRedirectUri("http://localhost:53211/callback", DEFAULT_REDIRECT_ALLOWLIST)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:9/callback", DEFAULT_REDIRECT_ALLOWLIST)).toBe(true);
  });

  // The whole point of the guard: an arbitrary https host must not receive a code.
  it("rejects an arbitrary https host", () => {
    expect(isAllowedRedirectUri("https://evil.example/cb", DEFAULT_REDIRECT_ALLOWLIST)).toBe(false);
  });

  // fastmcp's own matcher treats "." as a regex wildcard; ours must not.
  it("does not treat dots in the allowlist as wildcards", () => {
    expect(isAllowedRedirectUri("https://claudeXai/api/mcp/auth_callback", DEFAULT_REDIRECT_ALLOWLIST)).toBe(false);
  });

  it("rejects a path or host that merely resembles an allowed entry", () => {
    expect(isAllowedRedirectUri("https://claude.ai.evil.example/api/mcp/auth_callback", DEFAULT_REDIRECT_ALLOWLIST)).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback/../x", DEFAULT_REDIRECT_ALLOWLIST)).toBe(false);
  });

  it("rejects empty and unparseable input", () => {
    expect(isAllowedRedirectUri("", DEFAULT_REDIRECT_ALLOWLIST)).toBe(false);
    expect(isAllowedRedirectUri("://nope", DEFAULT_REDIRECT_ALLOWLIST)).toBe(false);
  });
});

// ─── extractPresentedToken ────────────────────────────────────────────

describe("extractPresentedToken", () => {
  it("reads a Bearer token", () => {
    expect(extractPresentedToken(req({ authorization: "Bearer abc123" }))).toBe("abc123");
  });

  it("treats the auth scheme as case-insensitive", () => {
    expect(extractPresentedToken(req({ authorization: "bearer abc123" }))).toBe("abc123");
  });

  it("handles an array-valued header (Node permits repeats)", () => {
    expect(extractPresentedToken(req({ authorization: ["Bearer abc123"] }))).toBe("abc123");
  });

  it("returns empty for a missing or valueless header", () => {
    expect(extractPresentedToken(req())).toBe("");
    expect(extractPresentedToken(req({ authorization: "Bearer" }))).toBe("");
    expect(extractPresentedToken(req({ authorization: "Basic xyz" }))).toBe("");
  });

  it("ignores ?token= unless explicitly enabled", () => {
    expect(extractPresentedToken(req({}, "/mcp?token=qqq"))).toBe("");
    expect(extractPresentedToken(req({}, "/mcp?token=qqq"), { allowQueryToken: true })).toBe("qqq");
  });

  // A bogus Authorization header must not be silently rescued by a valid query token.
  it("gives the Authorization header precedence over ?token=", () => {
    const r = req({ authorization: "Bearer header-value" }, "/mcp?token=query-value");
    expect(extractPresentedToken(r, { allowQueryToken: true })).toBe("header-value");
    const bogus = req({ authorization: "Basic nope" }, "/mcp?token=query-value");
    expect(extractPresentedToken(bogus, { allowQueryToken: true })).toBe("");
  });

  it("returns empty for an undefined request (stdio transport)", () => {
    expect(extractPresentedToken(undefined)).toBe("");
  });
});

// ─── safeTokenEqual ───────────────────────────────────────────────────

describe("safeTokenEqual", () => {
  it("matches identical secrets", () => {
    expect(safeTokenEqual("s3cret-value", "s3cret-value")).toBe(true);
  });

  it("rejects different secrets of equal length", () => {
    expect(safeTokenEqual("aaaa", "bbbb")).toBe(false);
  });

  it("rejects secrets of differing length without throwing", () => {
    expect(safeTokenEqual("short", "considerably-longer")).toBe(false);
  });

  // timingSafeEqual returns true for two empty buffers — this must not become
  // an authentication bypass.
  it("rejects empty input on either side", () => {
    expect(safeTokenEqual("", "")).toBe(false);
    expect(safeTokenEqual("", "real")).toBe(false);
    expect(safeTokenEqual("real", "")).toBe(false);
  });

  it("handles multibyte characters", () => {
    expect(safeTokenEqual("tökén-✓", "tökén-✓")).toBe(true);
    expect(safeTokenEqual("tökén-✓", "tökén-✗")).toBe(false);
  });
});

// ─── resolveAuthConfig ────────────────────────────────────────────────

describe("resolveAuthConfig", () => {
  describe("stdio transport", () => {
    it("requires no credentials at all", () => {
      const result = resolveAuthConfig({}, "stdio");
      expect(result.ok).toBe(true);
    });
  });

  describe("httpStream — fail closed", () => {
    it("refuses to start with nothing configured", () => {
      const result = resolveAuthConfig({}, "httpStream");
      expect(result.ok).toBe(false);
      expect(errorsOf(result).join(" ")).toMatch(/No authentication is configured/i);
    });

    it("accepts a valid static token alone", () => {
      const result = resolveAuthConfig({ MCP_AUTH_TOKEN: GOOD_TOKEN }, "httpStream");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.staticToken).toBe(GOOD_TOKEN);
        expect(result.config.oauth).toBeUndefined();
      }
    });

    it("treats a set-but-blank token as misconfiguration, not as unset", () => {
      const result = resolveAuthConfig({ MCP_AUTH_TOKEN: "   " }, "httpStream");
      expect(result.ok).toBe(false);
      expect(errorsOf(result).join(" ")).toMatch(/set but empty/i);
    });

    it("rejects a token shorter than the minimum", () => {
      const result = resolveAuthConfig({ MCP_AUTH_TOKEN: "abc" }, "httpStream");
      expect(result.ok).toBe(false);
      expect(errorsOf(result).join(" ")).toMatch(/too short/i);
    });

    it("rejects placeholder tokens", () => {
      const result = resolveAuthConfig({ MCP_AUTH_TOKEN: "changeme" }, "httpStream");
      expect(result.ok).toBe(false);
      expect(errorsOf(result).join(" ")).toMatch(/placeholder/i);
    });
  });

  describe("httpStream — OAuth", () => {
    it("accepts a complete configuration", () => {
      const result = resolveAuthConfig(validOAuthEnv(), "httpStream");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.oauth).toMatchObject({
          clientId: "client-id",
          publicUrl: "https://example.up.railway.app",
          tenantId: TENANT_GUID,
        });
        expect(result.config.oauth?.redirectAllowlist).toEqual(DEFAULT_REDIRECT_ALLOWLIST);
      }
    });

    it("rejects a partial configuration naming the missing vars", () => {
      const result = resolveAuthConfig({ AZURE_CLIENT_ID: "only-this" }, "httpStream");
      expect(result.ok).toBe(false);
      const joined = errorsOf(result).join(" ");
      expect(joined).toMatch(/partially configured/i);
      expect(joined).toContain("AZURE_CLIENT_SECRET");
      expect(joined).toContain("AZURE_TENANT_ID");
    });

    it("rejects a multi-tenant AZURE_TENANT_ID", () => {
      const result = resolveAuthConfig(validOAuthEnv({ AZURE_TENANT_ID: "common" }), "httpStream");
      expect(result.ok).toBe(false);
      expect(errorsOf(result).join(" ")).toMatch(/ANY Microsoft account/i);
    });

    it("rejects a missing or malformed MCP_PUBLIC_URL", () => {
      expect(resolveAuthConfig(validOAuthEnv({ MCP_PUBLIC_URL: undefined }), "httpStream").ok).toBe(false);
      expect(resolveAuthConfig(validOAuthEnv({ MCP_PUBLIC_URL: "https://x/" }), "httpStream").ok).toBe(false);
    });

    it("honors a custom redirect allowlist", () => {
      const result = resolveAuthConfig(
        validOAuthEnv({ MCP_OAUTH_REDIRECT_PATTERNS: "https://a.example/cb, https://b.example/cb" }),
        "httpStream",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.oauth?.redirectAllowlist).toEqual(["https://a.example/cb", "https://b.example/cb"]);
      }
    });

    it("allows OAuth and the static token together", () => {
      const result = resolveAuthConfig(validOAuthEnv({ MCP_AUTH_TOKEN: GOOD_TOKEN }), "httpStream");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.staticToken).toBe(GOOD_TOKEN);
        expect(result.config.oauth).toBeDefined();
      }
    });
  });

  describe("httpStream — MCP_AUTH_MODE", () => {
    it("ignores the static token in oauth mode and says so", () => {
      const result = resolveAuthConfig(
        validOAuthEnv({ MCP_AUTH_MODE: "oauth", MCP_AUTH_TOKEN: GOOD_TOKEN }),
        "httpStream",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.staticToken).toBeUndefined();
        expect(result.config.warnings.join(" ")).toMatch(/will be IGNORED/i);
      }
    });

    it("fails when oauth mode is requested without complete OAuth config", () => {
      const result = resolveAuthConfig({ MCP_AUTH_MODE: "oauth", MCP_AUTH_TOKEN: GOOD_TOKEN }, "httpStream");
      expect(result.ok).toBe(false);
    });

    it("warns that OAuth is not registered in static mode", () => {
      const result = resolveAuthConfig(
        validOAuthEnv({ MCP_AUTH_MODE: "static", MCP_AUTH_TOKEN: GOOD_TOKEN }),
        "httpStream",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.oauth).toBeUndefined();
        expect(result.config.warnings.join(" ")).toMatch(/OAuth routes will NOT be registered/i);
      }
    });

    it("rejects an unknown mode", () => {
      const result = resolveAuthConfig({ MCP_AUTH_MODE: "nope", MCP_AUTH_TOKEN: GOOD_TOKEN }, "httpStream");
      expect(result.ok).toBe(false);
      expect(errorsOf(result).join(" ")).toMatch(/MCP_AUTH_MODE/);
    });
  });

  describe("httpStream — reporting", () => {
    it("reports every problem at once rather than only the first", () => {
      const result = resolveAuthConfig(
        { AZURE_CLIENT_ID: "x", AZURE_TENANT_ID: "common", MCP_AUTH_TOKEN: "short" },
        "httpStream",
      );
      expect(result.ok).toBe(false);
      expect(errorsOf(result).length).toBeGreaterThanOrEqual(3);
    });

    it("never echoes secret values in error messages", () => {
      const secret = "sup3r-secret-value-that-must-not-leak";
      const result = resolveAuthConfig(
        { AZURE_CLIENT_ID: "x", AZURE_CLIENT_SECRET: secret, AZURE_TENANT_ID: "common" },
        "httpStream",
      );
      expect(result.ok).toBe(false);
      expect(errorsOf(result).join(" ")).not.toContain(secret);
    });

    it("warns when query tokens are enabled", () => {
      const result = resolveAuthConfig(
        { MCP_ALLOW_QUERY_TOKEN: "true", MCP_AUTH_TOKEN: GOOD_TOKEN },
        "httpStream",
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.allowQueryToken).toBe(true);
        expect(result.config.warnings.join(" ")).toMatch(/appears in proxy\/access logs/i);
      }
    });
  });
});

// ─── createAuthenticator ──────────────────────────────────────────────

describe("createAuthenticator", () => {
  /** Stub satisfying OAuthDelegate — an interface stand-in, not a mocked module. */
  function delegate(result: unknown): OAuthDelegate & { calls: number } {
    return {
      calls: 0,
      async authenticate() {
        this.calls++;
        return result;
      },
    };
  }

  async function expect401(fn: () => Promise<unknown>): Promise<void> {
    await expect(fn()).rejects.toMatchObject({ status: 401 });
  }

  it("accepts the correct static token", async () => {
    const auth = createAuthenticator({ staticToken: GOOD_TOKEN });
    await expect(auth(req({ authorization: `Bearer ${GOOD_TOKEN}` })))
      .resolves.toMatchObject({ authenticated: true, method: "static" });
  });

  it("rejects a wrong static token when no OAuth provider is configured", async () => {
    const auth = createAuthenticator({ staticToken: GOOD_TOKEN });
    await expect401(() => auth(req({ authorization: "Bearer wrong" })));
  });

  it("rejects a request with no credential at all", async () => {
    const auth = createAuthenticator({ staticToken: GOOD_TOKEN });
    await expect401(() => auth(req()));
  });

  it("falls through to OAuth when the static token does not match", async () => {
    const provider = delegate({ accessToken: "upstream" });
    const auth = createAuthenticator({ oauthProvider: provider, staticToken: GOOD_TOKEN });
    await expect(auth(req({ authorization: "Bearer some-oauth-jwt" })))
      .resolves.toMatchObject({ authenticated: true, method: "oauth" });
    expect(provider.calls).toBe(1);
  });

  it("does not consult OAuth when the static token matches", async () => {
    const provider = delegate({ accessToken: "upstream" });
    const auth = createAuthenticator({ oauthProvider: provider, staticToken: GOOD_TOKEN });
    await auth(req({ authorization: `Bearer ${GOOD_TOKEN}` }));
    expect(provider.calls).toBe(0);
  });

  /**
   * Regression test for the most dangerous failure mode in this file.
   *
   * fastmcp's AuthProvider.authenticate resolves to `undefined` on every
   * failure path, and fastmcp's stateful createServer does NOT null-check the
   * auth result before creating a session. If this function returned that
   * undefined instead of throwing, GET /sse — and the
   * POST /messages?sessionId= that follows it — would be reachable with no
   * credential at all.
   */
  it("THROWS 401 when the OAuth provider returns undefined (never returns it)", async () => {
    const provider = delegate(undefined);
    const auth = createAuthenticator({ oauthProvider: provider });
    await expect401(() => auth(req({ authorization: "Bearer expired-or-bogus" })));
    expect(provider.calls).toBe(1);
  });

  // Guards the timingSafeEqual empty-buffer trap: an empty presented value
  // must never authenticate, regardless of configuration.
  it("rejects an empty credential even if the configured token were empty", async () => {
    const auth = createAuthenticator({ staticToken: "" });
    await expect401(() => auth(req({ authorization: "Bearer " })));
    await expect401(() => auth(req()));
  });

  it("only honors ?token= when explicitly enabled", async () => {
    const disabled = createAuthenticator({ staticToken: GOOD_TOKEN });
    await expect401(() => disabled(req({}, `/mcp?token=${GOOD_TOKEN}`)));

    const enabled = createAuthenticator({ allowQueryToken: true, staticToken: GOOD_TOKEN });
    await expect(enabled(req({}, `/mcp?token=${GOOD_TOKEN}`)))
      .resolves.toMatchObject({ authenticated: true, method: "static" });
  });

  it("rejects an undefined request when a credential is required", async () => {
    const auth = createAuthenticator({ staticToken: GOOD_TOKEN });
    await expect401(() => auth(undefined));
  });
});
