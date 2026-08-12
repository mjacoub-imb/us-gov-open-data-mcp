/**
 * Regression tests for the OAuth route guards (`src/server/oauth-routes.ts`).
 *
 * These exist because fastmcp 3.35.0's built-in OAuth proxy ships two
 * exploitable routes, both served outside the authenticate gate:
 *
 *   B1  POST /oauth/register returns the UPSTREAM app's client_secret to any
 *       anonymous caller (`client_secret: this.config.upstreamClientSecret`).
 *   B2  GET /oauth/authorize never checks redirect_uri against any allowlist
 *       and treats PKCE as optional, so a crafted link can deliver a live
 *       authorization code to an attacker-controlled host.
 *
 * The guards shadow both routes on the Hono app. Each test below maps to a
 * specific attack; if one of these ever fails, the corresponding hole is open
 * again.
 *
 * The proxy is a hand-written stub implementing `OAuthProxyLike` — it
 * deliberately behaves like the REAL fastmcp proxy (i.e. it happily returns
 * the secret and accepts any redirect), so the tests prove our guard is what
 * blocks the attack rather than the stub being polite.
 */

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerOAuthGuards, type OAuthProxyLike } from "../src/server/oauth-routes.js";

// ─── Helpers ──────────────────────────────────────────────────────────

const UPSTREAM_SECRET = "THE-AZURE-APP-SECRET-MUST-NEVER-BE-RETURNED";
const UPSTREAM_CLIENT_ID = "azure-client-id";
const ALLOWLIST = ["https://claude.ai/api/mcp/auth_callback"];

/** Mirrors fastmcp's actual (unsafe) proxy behavior. */
function fakeProxy(): OAuthProxyLike & { authorizeCalls: unknown[] } {
  return {
    authorizeCalls: [],
    async authorize(params) {
      this.authorizeCalls.push(params);
      return new Response(null, {
        headers: { Location: "https://login.microsoftonline.com/authorize" },
        status: 302,
      });
    },
    async registerClient(request) {
      return {
        client_id: UPSTREAM_CLIENT_ID,
        client_name: request.client_name,
        client_secret: UPSTREAM_SECRET, // ← exactly what fastmcp does
        client_secret_expires_at: 0,
        redirect_uris: request.redirect_uris,
      };
    },
  };
}

function appWithGuards(allowlist = ALLOWLIST) {
  const app = new Hono();
  const proxy = fakeProxy();
  registerOAuthGuards(app, proxy, { redirectAllowlist: allowlist });
  return { app, proxy };
}

function authorizeUrl(params: Record<string, string>): string {
  return `http://localhost/oauth/authorize?${new URLSearchParams(params).toString()}`;
}

/** A request that passes every guard — used as the baseline to vary one field at a time. */
function validAuthorizeParams(): Record<string, string> {
  return {
    client_id: UPSTREAM_CLIENT_ID,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    state: "xyz",
  };
}

function registerRequest(body: unknown): Request {
  return new Request("http://localhost/oauth/register", {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

// ─── B1: client secret disclosure ─────────────────────────────────────

describe("POST /oauth/register — upstream credential disclosure (B1)", () => {
  it("never returns the upstream client_secret", async () => {
    const { app } = appWithGuards();
    const res = await app.fetch(registerRequest({ redirect_uris: ALLOWLIST }));

    expect(res.status).toBe(201);
    const raw = await res.text();
    // Assert on the raw body: no amount of nesting or renaming should let it through.
    expect(raw).not.toContain(UPSTREAM_SECRET);
    const body = JSON.parse(raw);
    expect(body.client_secret).toBeUndefined();
    expect(body.client_secret_expires_at).toBeUndefined();
  });

  it("still returns a usable registration (public client + PKCE)", async () => {
    const { app } = appWithGuards();
    const res = await app.fetch(registerRequest({ redirect_uris: ALLOWLIST }));
    const body = await res.json();

    expect(body.client_id).toBe(UPSTREAM_CLIENT_ID);
    // Advertising "none" is what makes a secretless client correct rather than
    // merely lucky — fastmcp's token exchange never checks the secret anyway.
    expect(body.token_endpoint_auth_method).toBe("none");
  });

  it("rejects registration of a redirect URI outside the allowlist", async () => {
    const { app } = appWithGuards();
    const res = await app.fetch(registerRequest({ redirect_uris: ["https://evil.example/cb"] }));

    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(raw).not.toContain(UPSTREAM_SECRET);
    expect(JSON.parse(raw).error).toBe("invalid_redirect_uri");
  });

  it("rejects a request with no redirect_uris", async () => {
    const { app } = appWithGuards();
    const res = await app.fetch(registerRequest({}));
    expect(res.status).toBe(400);
  });

  it("rejects a malformed body without leaking the secret", async () => {
    const { app } = appWithGuards();
    const res = await app.fetch(
      new Request("http://localhost/oauth/register", {
        body: "}{not json",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(UPSTREAM_SECRET);
  });

  it("rejects an oversized body", async () => {
    const { app } = appWithGuards();
    const res = await app.fetch(
      registerRequest({ padding: "x".repeat(20 * 1024), redirect_uris: ALLOWLIST }),
    );
    expect(res.status).toBe(413);
  });

  // The size check has to happen WHILE reading the body, not after it's
  // fully buffered — otherwise the 16KB cap doesn't bound the thing it
  // appears to, and an unauthenticated caller can force arbitrary memory use
  // before the 413 is ever produced. A stream that never ends proves this:
  // the old `c.req.text()` implementation awaits full consumption and would
  // never resolve, so this test would time out under the pre-fix behavior.
  it("rejects an oversized body from a stream without waiting for it to end", async () => {
    const { app } = appWithGuards();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });

    const res = await app.fetch(
      new Request("http://localhost/oauth/register", {
        body,
        // @ts-expect-error -- required by undici for streaming request bodies
        duplex: "half",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    );

    expect(res.status).toBe(413);
    expect(cancelled).toBe(true);
  }, 5_000);
});

// ─── B2: authorization code exfiltration ──────────────────────────────

describe("GET /oauth/authorize — redirect and PKCE enforcement (B2)", () => {
  it("passes a fully valid request through to the proxy", async () => {
    const { app, proxy } = appWithGuards();
    const res = await app.fetch(new Request(authorizeUrl(validAuthorizeParams())));

    expect(res.status).toBe(302);
    expect(proxy.authorizeCalls).toHaveLength(1);
  });

  it("rejects an attacker-controlled redirect_uri and never reaches the proxy", async () => {
    const { app, proxy } = appWithGuards();
    const res = await app.fetch(
      new Request(authorizeUrl({ ...validAuthorizeParams(), redirect_uri: "https://evil.example/cb" })),
    );

    expect(res.status).toBe(400);
    expect(proxy.authorizeCalls).toHaveLength(0);
  });

  // The error must not be delivered TO the rejected URI — that would be the
  // very exfiltration channel this guard exists to close.
  it("does not redirect the error back to the rejected URI", async () => {
    const { app } = appWithGuards();
    const res = await app.fetch(
      new Request(authorizeUrl({ ...validAuthorizeParams(), redirect_uri: "https://evil.example/cb" })),
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("Location")).toBeNull();
  });

  it("requires PKCE — a missing code_challenge is rejected", async () => {
    const { app, proxy } = appWithGuards();
    const params = validAuthorizeParams();
    delete params.code_challenge;
    delete params.code_challenge_method;

    const res = await app.fetch(new Request(authorizeUrl(params)));
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toMatch(/PKCE is required/i);
    expect(proxy.authorizeCalls).toHaveLength(0);
  });

  // "plain" would let an interceptor of the challenge redeem the code.
  it("requires S256 specifically, not plain", async () => {
    const { app } = appWithGuards();
    const res = await app.fetch(
      new Request(authorizeUrl({ ...validAuthorizeParams(), code_challenge_method: "plain" })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_description).toMatch(/S256/);
  });

  it("rejects a missing redirect_uri", async () => {
    const { app } = appWithGuards();
    const params = validAuthorizeParams();
    delete params.redirect_uri;
    expect((await app.fetch(new Request(authorizeUrl(params)))).status).toBe(400);
  });

  it("rejects missing client_id or response_type", async () => {
    const { app } = appWithGuards();
    for (const field of ["client_id", "response_type"]) {
      const params = validAuthorizeParams();
      delete params[field];
      expect((await app.fetch(new Request(authorizeUrl(params)))).status).toBe(400);
    }
  });

  it("allows loopback redirects for local clients", async () => {
    const { app, proxy } = appWithGuards();
    const res = await app.fetch(
      new Request(authorizeUrl({ ...validAuthorizeParams(), redirect_uri: "http://127.0.0.1:53211/callback" })),
    );
    expect(res.status).toBe(302);
    expect(proxy.authorizeCalls).toHaveLength(1);
  });

  it("honors a custom allowlist", async () => {
    const { app } = appWithGuards(["https://custom.example/cb"]);
    const ok = await app.fetch(
      new Request(authorizeUrl({ ...validAuthorizeParams(), redirect_uri: "https://custom.example/cb" })),
    );
    expect(ok.status).toBe(302);

    const denied = await app.fetch(new Request(authorizeUrl(validAuthorizeParams())));
    expect(denied.status).toBe(400);
  });
});
