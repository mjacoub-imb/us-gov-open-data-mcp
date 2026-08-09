/**
 * Hardening shims over fastmcp's built-in OAuth proxy routes.
 *
 * fastmcp serves /oauth/* from its raw HTTP handler, outside the authenticate
 * gate. Two of those routes are unsafe as shipped (verified against
 * fastmcp 3.35.0's bundled OAuthProxy):
 *
 *   1. POST /oauth/register — Dynamic Client Registration echoes the UPSTREAM
 *      app's credentials back to the caller:
 *          client_secret: this.config.upstreamClientSecret
 *      Since the route is unauthenticated, anyone who can reach the server can
 *      retrieve our Entra application's client ID and secret with a single
 *      curl, then run flows under our app's identity — including showing our
 *      own users a Microsoft consent screen bearing our app's name.
 *
 *   2. GET /oauth/authorize — validates only that `redirect_uri` is PRESENT,
 *      never that it is permitted (`validateRedirectUri` is called from
 *      registerClient only), and treats PKCE as optional. So a crafted link
 *      to our own domain can deliver a live authorization code to an
 *      attacker's host, and the code can then be redeemed without a verifier.
 *
 * Narrowing fastmcp's `allowedRedirectUriPatterns` does NOT fix (2): that
 * check falls open — when no configured pattern matches it still returns true
 * for any https: URI. The allowlist therefore has to be enforced here.
 *
 * Both routes are registered on the Hono app returned by `server.getApp()`.
 * fastmcp's request handler calls `honoApp.fetch()` first and returns
 * immediately on any non-404 response, before its own OAuth block — so these
 * handlers shadow the built-in ones.
 *
 * Stripping the client secret is functionally safe: the proxy's
 * `exchangeAuthorizationCode` never inspects `client_secret`; it matches on
 * `client_id` and validates PKCE. Advertising the client as public
 * (token_endpoint_auth_method: "none") plus mandatory PKCE below is a
 * strictly stronger posture than the shipped behavior.
 */

import type { Hono } from "hono";
import { isAllowedRedirectUri } from "./auth.js";

/** The bits of fastmcp's OAuthProxy these guards call through to. */
export interface OAuthProxyLike {
  authorize(params: Record<string, unknown> & {
    client_id: string;
    redirect_uri: string;
    response_type: string;
  }): Promise<Response>;
  registerClient(request: Record<string, unknown>): Promise<Record<string, unknown>>;
}

/** Max size of a DCR request body we'll parse (registration metadata is small). */
const MAX_DCR_BODY_BYTES = 16 * 1024;

function oauthError(error: string, description: string, status = 400): Response {
  return new Response(JSON.stringify({ error, error_description: description }), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

/** Pull a numeric `statusCode` off a thrown error, falling back when absent or non-numeric. */
function statusFrom(err: unknown, fallback = 400): number {
  const status = (err as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" ? status : fallback;
}

/**
 * Register hardened /oauth/register and /oauth/authorize handlers.
 *
 * @param app     the Hono app from `server.getApp()`
 * @param proxy   the OAuthProxy from `provider.getProxy()`
 * @param options redirect allowlist enforced on the authorize endpoint
 */
export function registerOAuthGuards(
  app: Hono,
  proxy: OAuthProxyLike,
  options: { redirectAllowlist: string[] },
): void {
  const { redirectAllowlist } = options;

  // ─── POST /oauth/register ──────────────────────────────────────────
  //
  // Delegate to the proxy so its bookkeeping still happens, then strip the
  // upstream credentials out of the response before it leaves the process.
  app.post("/oauth/register", async c => {
    let body: Record<string, unknown>;
    try {
      const raw = await c.req.text();
      if (raw.length > MAX_DCR_BODY_BYTES) {
        return oauthError("invalid_client_metadata", "Registration request too large.", 413);
      }
      body = JSON.parse(raw || "{}") as Record<string, unknown>;
    } catch {
      return oauthError("invalid_client_metadata", "Request body must be valid JSON.");
    }

    // Enforce our allowlist at registration too, so an attacker can't park a
    // hostile redirect_uri in the proxy's client map.
    const redirectUris = Array.isArray(body.redirect_uris) ? (body.redirect_uris as unknown[]) : [];
    if (redirectUris.length === 0) {
      return oauthError("invalid_client_metadata", "redirect_uris is required.");
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string" || !isAllowedRedirectUri(uri, redirectAllowlist)) {
        return oauthError("invalid_redirect_uri", `Redirect URI is not permitted: ${String(uri)}`);
      }
    }

    let registration: Record<string, unknown>;
    try {
      registration = await proxy.registerClient(body);
    } catch (err) {
      return oauthError("invalid_client_metadata", (err as Error)?.message ?? "Registration failed.", statusFrom(err));
    }

    // The whole point of this shim: never return the upstream app's secret.
    const {
      client_secret: _clientSecret,
      client_secret_expires_at: _clientSecretExpiresAt,
      ...safe
    } = registration;

    return c.json({ ...safe, token_endpoint_auth_method: "none" }, 201);
  });

  // ─── GET /oauth/authorize ──────────────────────────────────────────
  //
  // Enforce the redirect allowlist and mandatory PKCE before handing off.
  // Requiring code_challenge here is what makes the proxy enforce PKCE at
  // token-exchange time too — it only validates a verifier when a challenge
  // was stored on the code.
  app.get("/oauth/authorize", async c => {
    const params = c.req.query();

    const redirectUri = params.redirect_uri ?? "";
    if (!redirectUri) {
      return oauthError("invalid_request", "redirect_uri is required.");
    }
    if (!isAllowedRedirectUri(redirectUri, redirectAllowlist)) {
      // Deliberately does NOT redirect the error back to the caller-supplied
      // URI — that would be the very exfiltration path this check exists to
      // close.
      return oauthError(
        "invalid_request",
        "redirect_uri is not on this server's allowlist.",
      );
    }

    if (!params.code_challenge) {
      return oauthError("invalid_request", "PKCE is required: code_challenge is missing.");
    }
    if (params.code_challenge_method !== "S256") {
      return oauthError("invalid_request", "PKCE code_challenge_method must be S256.");
    }
    if (!params.client_id || !params.response_type) {
      return oauthError("invalid_request", "Missing required parameters.");
    }

    try {
      return await proxy.authorize(
        params as Record<string, unknown> & {
          client_id: string;
          redirect_uri: string;
          response_type: string;
        },
      );
    } catch (err) {
      return oauthError(
        (err as { code?: string })?.code ?? "invalid_request",
        (err as Error)?.message ?? "Authorization failed.",
        statusFrom(err),
      );
    }
  });
}
