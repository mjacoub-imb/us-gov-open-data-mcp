/**
 * Authentication configuration and request authentication for the HTTP transport.
 *
 * The stdio transport is trusted by construction (a local pipe to a single
 * local client). httpStream is not: it's a network listener, and this server
 * holds live API keys for ~40 upstream services. Everything here exists to
 * make sure that listener can never come up in a state where an anonymous
 * caller can reach a tool.
 *
 * Two credential types are supported, and both may be active at once:
 *   - a shared static bearer token (MCP_AUTH_TOKEN) for CLI/script clients
 *   - Microsoft Entra ID OAuth, for humans signing in with a work account
 *
 * The functions here are deliberately pure (env in, decision out) so the
 * startup rules can be unit-tested — see tests/auth.test.ts. `server.ts`
 * only ever wires them together.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

// ─── Types ───────────────────────────────────────────────────────────

/** Which credential types the server will accept. */
export type AuthMode = "both" | "oauth" | "static";

export interface OAuthSettings {
  clientId: string;
  clientSecret: string;
  /** Exact public origin (no trailing slash) — drives baseUrl and the redirect URI. */
  publicUrl: string;
  /** Redirect URIs permitted to receive an authorization code. */
  redirectAllowlist: string[];
  tenantId: string;
  encryptionKey?: string;
  jwtSigningKey?: string;
}

export interface AuthConfig {
  /** Accept `?token=` in addition to the Authorization header. Off unless opted in. */
  allowQueryToken: boolean;
  mode: AuthMode;
  oauth?: OAuthSettings;
  staticToken?: string;
  /** Non-fatal notes to print at startup. */
  warnings: string[];
}

export type AuthResolution =
  | { config: AuthConfig; ok: true }
  | { errors: string[]; ok: false };

/** Minimal shape of the env we read. Passing this in (rather than reading
 *  process.env directly) is what makes the startup rules testable. */
export type AuthEnv = Record<string, string | undefined>;

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Minimum length for the shared static token. Matches the
 * `openssl rand -hex 32` guidance in .env.example — a short token here is a
 * typo, not a deliberate choice, and silently accepting one downgrades the
 * whole deployment to a guessable secret.
 */
export const MIN_STATIC_TOKEN_LENGTH = 32;

/** Values that look like an unedited copy/paste rather than a real secret. */
const PLACEHOLDER_TOKENS = new Set([
  "changeme",
  "your-token-here",
  "your_token_here",
  "secret",
  "password",
  "token",
  "test",
  "replace-me",
  "yourtokenhere",
]);

/**
 * Entra "tenant" values that mean *any* Microsoft account, not our directory.
 * AzureProvider defaults tenantId to "common", so leaving this unset would
 * silently let the entire world sign in — the config must name a real tenant.
 */
const MULTI_TENANT_VALUES = new Set(["common", "consumers", "organizations"]);

/**
 * Redirect URIs allowed to receive an authorization code.
 *
 * Anthropic documents claude.ai/api/mcp/auth_callback as the connector
 * callback and notes it may migrate to claude.com, so both are listed.
 * Claude Code uses loopback with an arbitrary port.
 *
 * NOTE: this list is enforced by `isAllowedRedirectUri` below, NOT by
 * fastmcp's own `allowedRedirectUriPatterns` — that option fails open
 * (it returns true for any https: URI when no pattern matches), so it
 * cannot be relied on to restrict anything.
 */
export const DEFAULT_REDIRECT_ALLOWLIST = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+$/;

// ─── Validators ──────────────────────────────────────────────────────

/**
 * Validate an Entra tenant identifier.
 *
 * Accepts a directory GUID or a verified domain (contoso.onmicrosoft.com).
 * Rejects the multi-tenant aliases, and — more importantly — anything that
 * isn't a bare identifier: the value is interpolated straight into
 * `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
 * so a value containing "@" would make login.microsoftonline.com the
 * userinfo and hand the whole authorization flow to another host. The
 * GUID/domain shapes structurally exclude "@", "/", "?", "#" and whitespace.
 */
export function validateTenantId(raw: string | undefined): { error: string } | { value: string } {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return { error: "AZURE_TENANT_ID is required when Microsoft OAuth is enabled." };
  if (MULTI_TENANT_VALUES.has(v)) {
    return {
      error:
        `AZURE_TENANT_ID="${v}" allows sign-in from ANY Microsoft account, not just your organization. ` +
        `Set it to your directory (tenant) GUID instead.`,
    };
  }
  if (!GUID_RE.test(v) && !DOMAIN_RE.test(v)) {
    return {
      error:
        `AZURE_TENANT_ID must be a directory GUID (e.g. 00000000-0000-0000-0000-000000000000) ` +
        `or a verified domain (e.g. contoso.onmicrosoft.com).`,
    };
  }
  return { value: v };
}

/**
 * Validate the server's public origin.
 *
 * `new URL(v).origin === v` is a single check that rejects a trailing slash,
 * any path/query/fragment, userinfo, and explicit-default-port forms. That
 * matters because Entra matches redirect URIs by exact string: a trailing
 * slash here produces "https://host//oauth/callback" and fails at first
 * login with AADSTS50011 rather than at startup.
 */
export function validatePublicUrl(raw: string | undefined): { error: string } | { value: string } {
  const v = (raw ?? "").trim();
  if (!v) return { error: "MCP_PUBLIC_URL is required when Microsoft OAuth is enabled." };

  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return { error: `MCP_PUBLIC_URL is not a valid URL: "${v}"` };
  }

  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !isLoopback) {
    return { error: `MCP_PUBLIC_URL must use https:// (got "${url.protocol}//"). Entra rejects non-HTTPS redirect URIs outside localhost.` };
  }
  if (url.origin !== v) {
    return {
      error:
        `MCP_PUBLIC_URL must be a bare origin with no trailing slash or path — ` +
        `expected "${url.origin}", got "${v}".`,
    };
  }
  return { value: url.origin };
}

/**
 * Is this redirect URI allowed to receive an authorization code?
 *
 * Exact match against the allowlist, plus loopback (any port) for local
 * clients such as Claude Code. Deliberately exact rather than pattern-based:
 * fastmcp's own matcher turns a pattern into a RegExp by replacing "*" with
 * ".*" without escaping any other metacharacter, so "." stays a wildcard
 * there and "https://claude.ai/x" would also match "https://claudeXai/x".
 */
export function isAllowedRedirectUri(uri: string, allowlist: string[]): boolean {
  if (!uri) return false;

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  if (allowlist.includes(uri)) return true;

  // Loopback with any port — Claude Code and other local clients bind an
  // ephemeral port, so the port can't be known ahead of time. Restricted to
  // http/https on literal loopback hosts.
  const isLoopbackHost = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (isLoopbackHost && (url.protocol === "http:" || url.protocol === "https:")) return true;

  return false;
}

// ─── Token extraction ────────────────────────────────────────────────

/**
 * Pull the credential a caller presented.
 *
 * The Authorization header wins over `?token=` so a bogus header can't be
 * silently rescued by a query param. Query tokens are only read when
 * explicitly enabled — they leak into proxy/access logs and Referer headers.
 */
export function extractPresentedToken(
  request: IncomingMessage | undefined,
  opts: { allowQueryToken?: boolean } = {},
): string {
  if (!request) return "";

  const rawHeader = request.headers?.authorization;
  const header = Array.isArray(rawHeader) ? rawHeader[0] ?? "" : rawHeader ?? "";
  // Scheme is case-insensitive per RFC 7235.
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  if (match) return match[1].trim();
  if (header.trim()) return ""; // an Authorization header was sent but isn't a usable Bearer

  if (opts.allowQueryToken) {
    try {
      const url = new URL(request.url ?? "", "http://localhost");
      return url.searchParams.get("token")?.trim() ?? "";
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * Constant-time secret comparison.
 *
 * Both sides are SHA-256'd first so the compared buffers are always 32 bytes:
 * `timingSafeEqual` throws on length mismatch, and an early length check
 * would leak the token's length. Note `timingSafeEqual` returns true for two
 * empty buffers, so callers must reject empty input before calling this.
 */
export function safeTokenEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

// ─── Config resolution ───────────────────────────────────────────────

function isTruthyFlag(v: string | undefined): boolean {
  return /^(1|true|yes)$/i.test((v ?? "").trim());
}

/**
 * Validate every auth-related env var and decide what the server will accept.
 *
 * Returns ALL problems at once rather than failing on the first: each
 * redeploy cycle on a PaaS costs minutes, and discovering misconfiguration
 * one variable at a time is the main reason this kind of setup drags.
 */
export function resolveAuthConfig(env: AuthEnv, transport: string): AuthResolution {
  const warnings: string[] = [];

  // stdio is a local pipe to one trusted client — none of this applies.
  if (transport !== "httpStream") {
    return {
      config: { allowQueryToken: false, mode: "both", warnings },
      ok: true,
    };
  }

  const errors: string[] = [];

  // ── Mode ──
  const rawMode = (env.MCP_AUTH_MODE ?? "both").trim().toLowerCase();
  if (!["both", "oauth", "static"].includes(rawMode)) {
    errors.push(`MCP_AUTH_MODE must be one of: static, oauth, both (got "${rawMode}").`);
  }
  const mode = (["both", "oauth", "static"].includes(rawMode) ? rawMode : "both") as AuthMode;

  // ── Static token ──
  const rawToken = env.MCP_AUTH_TOKEN;
  const token = (rawToken ?? "").trim();
  let staticToken: string | undefined;

  if (rawToken !== undefined && token === "") {
    // Set-but-blank is a misconfiguration, not "unset" — treating it as unset
    // could silently drop an intended auth method.
    errors.push("MCP_AUTH_TOKEN is set but empty. Unset it, or set a real secret.");
  } else if (token) {
    if (mode === "oauth") {
      warnings.push("MCP_AUTH_TOKEN is set but MCP_AUTH_MODE=oauth — the static token will be IGNORED.");
    } else if (PLACEHOLDER_TOKENS.has(token.toLowerCase())) {
      errors.push("MCP_AUTH_TOKEN is a placeholder value. Generate a real secret: openssl rand -hex 32");
    } else if (token.length < MIN_STATIC_TOKEN_LENGTH) {
      errors.push(
        `MCP_AUTH_TOKEN is too short (${token.length} chars, minimum ${MIN_STATIC_TOKEN_LENGTH}). ` +
        `Generate one with: openssl rand -hex 32`,
      );
    } else {
      staticToken = token;
    }
  }

  // ── OAuth ──
  const azureVars = {
    AZURE_CLIENT_ID: (env.AZURE_CLIENT_ID ?? "").trim(),
    AZURE_CLIENT_SECRET: (env.AZURE_CLIENT_SECRET ?? "").trim(),
    AZURE_TENANT_ID: (env.AZURE_TENANT_ID ?? "").trim(),
  };
  const providedAzure = Object.entries(azureVars).filter(([, v]) => v !== "");
  const oauthRequested = providedAzure.length > 0 || mode === "oauth";

  let oauth: OAuthSettings | undefined;

  if (oauthRequested && mode !== "static") {
    const missing = Object.entries(azureVars).filter(([, v]) => v === "").map(([k]) => k);
    if (missing.length > 0) {
      // Partial config would silently leave OAuth disabled.
      errors.push(`Microsoft OAuth is partially configured — missing: ${missing.join(", ")}.`);
    }

    const tenant = validateTenantId(azureVars.AZURE_TENANT_ID);
    if ("error" in tenant) {
      if (azureVars.AZURE_TENANT_ID) errors.push(tenant.error);
    }

    const publicUrl = validatePublicUrl(env.MCP_PUBLIC_URL);
    if ("error" in publicUrl) errors.push(publicUrl.error);

    const redirectAllowlist = (env.MCP_OAUTH_REDIRECT_PATTERNS ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    if (
      missing.length === 0 &&
      "value" in tenant &&
      "value" in publicUrl
    ) {
      oauth = {
        clientId: azureVars.AZURE_CLIENT_ID,
        clientSecret: azureVars.AZURE_CLIENT_SECRET,
        encryptionKey: env.MCP_OAUTH_ENCRYPTION_KEY?.trim() || undefined,
        jwtSigningKey: env.MCP_OAUTH_JWT_SIGNING_KEY?.trim() || undefined,
        publicUrl: publicUrl.value,
        redirectAllowlist: redirectAllowlist.length ? redirectAllowlist : DEFAULT_REDIRECT_ALLOWLIST,
        tenantId: tenant.value,
      };

      if (!oauth.jwtSigningKey || !oauth.encryptionKey) {
        warnings.push(
          "MCP_OAUTH_JWT_SIGNING_KEY / MCP_OAUTH_ENCRYPTION_KEY not set — keys are generated per process. " +
          "Note that OAuth sessions do not survive a restart regardless, since token storage is in-memory.",
        );
      }
    }
  } else if (providedAzure.length > 0 && mode === "static") {
    warnings.push("AZURE_* variables are set but MCP_AUTH_MODE=static — OAuth routes will NOT be registered.");
  }

  // ── Query-token opt-in ──
  const allowQueryToken = isTruthyFlag(env.MCP_ALLOW_QUERY_TOKEN);
  if (allowQueryToken) {
    warnings.push(
      "MCP_ALLOW_QUERY_TOKEN is enabled — ?token= bypasses OAuth and appears in proxy/access logs and Referer headers.",
    );
  }

  // ── Fail closed: at least one usable credential type ──
  const willHaveStatic = mode !== "oauth" && staticToken !== undefined;
  const willHaveOAuth = oauth !== undefined;

  if (!willHaveStatic && !willHaveOAuth && errors.length === 0) {
    errors.push(
      "No authentication is configured for --transport httpStream (refusing to start unauthenticated on a network listener). " +
      "Set MCP_AUTH_TOKEN to a long random secret (openssl rand -hex 32), and/or configure Microsoft OAuth " +
      "(AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID, MCP_PUBLIC_URL).",
    );
  }

  if (errors.length > 0) return { errors, ok: false };

  return {
    config: {
      allowQueryToken,
      mode,
      oauth,
      staticToken: mode === "oauth" ? undefined : staticToken,
      warnings,
    },
    ok: true,
  };
}

// ─── Authenticator ───────────────────────────────────────────────────

/** The subset of fastmcp's AuthProvider that the authenticator needs. */
export interface OAuthDelegate {
  authenticate(request: IncomingMessage | undefined): Promise<unknown>;
}

export interface AuthenticatedSession {
  authenticated: true;
  method: "oauth" | "static";
  [key: string]: unknown;
}

function unauthorized(): never {
  // fastmcp/mcp-proxy turns a thrown Response into the HTTP reply.
  throw new Response(null, { status: 401, statusText: "Unauthorized" });
}

/**
 * Build the `authenticate` function FastMCP calls for every request.
 *
 * Order: static token, then OAuth. The branches are disjoint (one compares
 * against a local secret, the other verifies a signed token), so trying the
 * cheap one first leaks nothing an attacker doesn't already assume.
 *
 * CRITICAL: this must THROW on failure, never return undefined. fastmcp's
 * stateful `createServer` path does not null-check the auth result before
 * creating a session, so returning undefined would leave GET /sse (and the
 * POST /messages?sessionId= that follows it) reachable with no credential
 * at all. tests/auth.test.ts pins this.
 */
export function createAuthenticator(opts: {
  allowQueryToken?: boolean;
  oauthProvider?: OAuthDelegate;
  staticToken?: string;
}): (request: IncomingMessage | undefined) => Promise<AuthenticatedSession> {
  const { allowQueryToken = false, oauthProvider, staticToken } = opts;

  return async (request: IncomingMessage | undefined): Promise<AuthenticatedSession> => {
    const presented = extractPresentedToken(request, { allowQueryToken });

    // Static token. Skipped entirely when none is configured, so an empty
    // presented value can never compare equal to an empty configured value.
    if (staticToken && presented && safeTokenEqual(presented, staticToken)) {
      return { authenticated: true, method: "static" };
    }

    if (oauthProvider) {
      const session = await oauthProvider.authenticate(request);
      if (session) {
        return { ...(session as Record<string, unknown>), authenticated: true, method: "oauth" };
      }
    }

    unauthorized();
  };
}
