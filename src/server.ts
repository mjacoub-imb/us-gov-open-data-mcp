#!/usr/bin/env node
/**
 * FastMCP server — auto-discovers API modules from src/apis/{name}/ folders.
 *
 * Each module folder exports: name, displayName, description, auth?, workflow?, tips?, domains, crossRef?, reference?, tools[]
 * This file auto-registers tools, generates resources + instructions, and adds clear_cache.
 *
 * Adding a new API = create an apis/{name}/ folder with sdk.ts, meta.ts, tools.ts, index.ts.
 * No wiring needed — the server discovers it automatically.
 *
 * Supports:
 *   - stdio transport (default, for VS Code / Claude Desktop / Cursor)
 *   - HTTP Stream transport (for web apps, remote access)
 *   - Selective module loading (load only what you need)
 *
 * Usage:
 *   node dist/server.js                                   # stdio (default)
 *   node dist/server.js --transport httpStream --port 8080 # HTTP on port 8080
 *   MODULES=fred,bls,treasury node dist/server.js         # load only 3 modules
 *   node dist/server.js --modules fred,bls,treasury       # same via CLI flag
 *   node dist/server.js --list-modules                    # list all modules grouped by domain and exit
 *   node dist/server.js --list                            # alias for --list-modules
 *   node dist/server.js --list-modules --json             # same, as JSON (for scripting)
 */

import "dotenv/config";
import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { timingSafeEqual } from "crypto";
import { FastMCP, type Tool, type InputPrompt } from "fastmcp";
import { z } from "zod";
import { buildInstructions } from "./server/instructions.js";
import { buildAnalysisPrompts } from "./server/prompts.js";
import { executeInSandbox } from "./shared/sandbox.js";
import { DOMAINS, type ApiModule } from "./shared/types.js";

const logger = {
  ...console,
  warn: (...args: unknown[]) => {
    // Some MCP clients (including some VS Code builds) don't report capabilities during init.
    // FastMCP emits a warning after a short retry loop; it's typically harmless for stdio.
    if (
      args.some(
        a =>
          typeof a === "string" &&
          a.includes("[FastMCP warning] could not infer client capabilities"),
      )
    ) {
      return;
    }
    console.warn(...(args as [unknown, ...unknown[]]));
  },
};

const MODULES: ApiModule[] = [];

// Auto-discover API modules from apis/ subdirectories
const __dirname = dirname(fileURLToPath(import.meta.url));
const apisDir = join(__dirname, "apis");
const apiDirs = readdirSync(apisDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

for (const dir of apiDirs) {
  try {
    const mod = await import(`./apis/${dir}/index.js`);
    MODULES.push(mod.default as ApiModule);
  } catch (err) {
    console.error(`Failed to load module "${dir}":`, (err as Error).message);
  }
}

// ─── CLI arg + env parsing ───────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
  };

  const transport = (get("--transport") ?? process.env.MCP_TRANSPORT ?? "stdio") as "stdio" | "httpStream";
  // Railway (and most PaaS) inject PORT; prefer explicit overrides but fall back to it.
  const port = Number(get("--port") ?? process.env.MCP_PORT ?? process.env.PORT ?? 8080);
  const modulesFilter = get("--modules") ?? process.env.MODULES;
  const listModules = args.includes("--list-modules") || args.includes("--list");

  return { transport, port, modulesFilter, listModules };
}

const { transport, port, modulesFilter, listModules } = parseArgs();

if (listModules) {
  const asJson = process.argv.includes("--json");

  if (asJson) {
    const output = MODULES.map(m => ({
      name: m.name,
      displayName: m.displayName,
      toolCount: m.tools.length,
      requiresApiKey: !!m.auth,
      envVars: m.auth ? (Array.isArray(m.auth.envVar) ? m.auth.envVar : [m.auth.envVar]) : null,
      signupUrl: m.auth?.signup ?? null,
      domains: m.domains,
    }));
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  // Group by primary (first) domain, in canonical DOMAINS order
  const groups = new Map<string, ApiModule[]>(DOMAINS.map(d => [d, []]));
  for (const m of MODULES) {
    const key = m.domains[0] ?? "other";
    groups.get(key)?.push(m);
  }

  const maxNameLen = Math.max(...MODULES.map(m => m.name.length));
  const maxDisplayLen = Math.max(...MODULES.map(m => m.displayName.length));
  const maxToolsLen = Math.max(...MODULES.map(m => `${m.tools.length} tools`.length));

  for (const [domain, mods] of groups) {
    if (mods.length === 0) continue;
    console.log(`\n${domain.charAt(0).toUpperCase() + domain.slice(1)}`);
    for (const m of mods) {
      const toolsStr = `${m.tools.length} tools`.padEnd(maxToolsLen);
      const envVars = m.auth ? (Array.isArray(m.auth.envVar) ? m.auth.envVar : [m.auth.envVar]) : null;
      const authNote = envVars ? `  [${envVars.join(", ")}]  ${m.auth!.signup}` : "";
      console.log(`  ${m.name.padEnd(maxNameLen)}  ${m.displayName.padEnd(maxDisplayLen)}  ${toolsStr}${authNote}`);
    }
  }
  console.log(`\n${MODULES.length} modules total.`);
  process.exit(0);
}

// ─── Selective module loading ────────────────────────────────────────

let activeModules = MODULES;

if (modulesFilter) {
  const wanted = new Set(modulesFilter.split(",").map(s => s.trim().toLowerCase()));
  activeModules = MODULES.filter(m => wanted.has(m.name.toLowerCase()));

  if (activeModules.length === 0) {
    console.error(
      `No modules matched "${modulesFilter}". Available: ${MODULES.map(m => m.name).join(", ")}`,
    );
    process.exit(1);
  }

  console.error(
    `Loaded ${activeModules.length}/${MODULES.length} modules: ${activeModules.map(m => m.name).join(", ")}`,
  );
}

// ─── Startup validation ──────────────────────────────────────────────

for (const mod of activeModules) {
  if (mod.auth) {
    const vars = Array.isArray(mod.auth.envVar) ? mod.auth.envVar : [mod.auth.envVar];
    const missing = vars.filter(v => !process.env[v]);
    if (missing.length > 0) {
      // IMPORTANT: for MCP stdio transport, stdout must be reserved for JSON-RPC only.
      // VS Code treats stderr output as warnings; keep it minimal and only log actionable issues.
      console.warn(
        `\u26A0 ${mod.displayName}: ${missing.join(", ")} not set \u2014 tools will fail. Get key: ${mod.auth.signup}`,
      );
    }
  }
}

// ─── HTTP transport auth ──────────────────────────────────────────────
//
// The stdio transport is trusted-by-construction (one local process talking
// to one local client over a pipe). httpStream is not — it's a network
// listener, and this server holds live API keys for ~40 upstream services.
// Refuse to expose it without a bearer token: failing open here would let
// anyone who finds the URL burn our API quotas and use us as an open proxy.

const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

if (transport === "httpStream" && !MCP_AUTH_TOKEN) {
  console.error(
    "MCP_AUTH_TOKEN is required when using --transport httpStream (refusing to start unauthenticated on a network listener). " +
    "Set MCP_AUTH_TOKEN to a long random secret and pass it as a Bearer token or ?token= query param.",
  );
  process.exit(1);
}

/** Constant-time string compare — avoids leaking the token via response-timing side channels. */
function safeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ─── Server ──────────────────────────────────────────────────────────

const server = new FastMCP({
  name: "US Government Open Data",
  version: "2.0.0",
  logger,
  instructions: buildInstructions(activeModules),
  health: { enabled: true, path: "/health", message: "ok" },
  ...(MCP_AUTH_TOKEN && {
    authenticate: async (request: import("http").IncomingMessage) => {
      const header = request.headers.authorization ?? "";
      const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
      const url = new URL(request.url ?? "", "http://localhost");
      const queryToken = url.searchParams.get("token") ?? "";
      const provided = bearer || queryToken;

      if (!provided || !safeTokenEqual(provided, MCP_AUTH_TOKEN)) {
        throw new Response(null, { status: 401, statusText: "Unauthorized" });
      }
      return { authenticated: true };
    },
  }),
});

// ─── Register all module tools + prompts ─────────────────────────────

/**
 * Default tool annotations applied to every module tool.
 *
 * All government data tools are read-only fetches against external APIs that
 * are safe to retry with identical args (data is published, not user-driven),
 * so they're idempotent and openWorld by default. Per-tool annotations
 * (e.g. `title`) are preserved via spread.
 */
const DEFAULT_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
  destructiveHint: false,
} as const;

for (const mod of activeModules) {
  const annotated = mod.tools.map(t => ({
    ...t,
    annotations: { ...DEFAULT_TOOL_ANNOTATIONS, ...(t.annotations ?? {}) },
  }));
  server.addTools(annotated as any);
  if (mod.prompts?.length) server.addPrompts(mod.prompts as any);
}

// ─── clear_cache tool ────────────────────────────────────────────────

server.addTool({
  name: "clear_cache",
  description: "Clear cached API responses to force fresh data on next query. " +
    "Specify a source name or omit to clear all.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  parameters: z.object({
    source: z.string().optional().describe(
      `Module name to clear: ${activeModules.map(m => m.name).join(", ")}. Omit for all.`
    ),
  }),
  execute: async ({ source }) => {
    const target = source?.toLowerCase();
    const cleared: string[] = [];
    for (const mod of activeModules) {
      if (target && mod.name.toLowerCase() !== target) continue;
      if (mod.clearCache) { mod.clearCache(); cleared.push(mod.name); }
    }
    return cleared.length
      ? `Cache cleared: ${cleared.join(", ")}. Next queries will fetch fresh data.`
      : source ? `Unknown source "${source}". Available: ${activeModules.map(m => m.name).join(", ")}` : "No caches to clear.";
  },
});

// ─── Cross-cutting analysis prompts ──────────────────────────────────

server.addPrompts(buildAnalysisPrompts(activeModules) as any);

// ─── Code mode tool ──────────────────────────────────────────────────

/**
 * Tool-name alias map. Resolves old/legacy names to current canonical names
 * inside `code_mode` so cached client prompts and saved system messages keep
 * working after a tool rename. Empty today — populate when a tool is renamed.
 */
const TOOL_ALIASES: Record<string, string> = {
  // Example for future use:
  // "fda_search_events": "fda_drug_events",
};

// Build a lookup map of all registered tools for code_mode to call.
// Keep the schema alongside execute — code_mode calls execute() directly,
// bypassing the framework's own CallToolRequestSchema handler (and the
// "~standard".validate() step it normally runs before invoking a tool), so
// code_mode has to replicate that validation itself or every tool's Zod
// schema — enum constraints, numeric bounds, format checks — becomes
// unenforced for any call routed through here.
interface RegisteredTool {
  parameters?: { "~standard": { validate: (value: unknown) => Promise<{ value: unknown; issues?: readonly { path?: readonly (string | number)[]; message: string }[] }> } };
  execute: (args: Record<string, unknown>, context: unknown) => Promise<unknown>;
}
const allToolMap = new Map<string, RegisteredTool>();
for (const mod of activeModules) {
  for (const tool of mod.tools) {
    allToolMap.set(tool.name, tool as unknown as RegisteredTool);
  }
}

server.addTool({
  name: "code_mode",
  description:
    "Run a JavaScript processing script against any tool's output in a WASM sandbox.\n" +
    "Calls the specified tool first, then runs your script with the raw response as `DATA` (string).\n" +
    "Only your script's console.log() output enters context — typically 65-99% smaller.\n\n" +
    "USE THIS when you need specific fields, counts, or filters from a large response.\n" +
    "DO NOT use this when you need to read and interpret the full data for cross-referencing or analysis.\n\n" +
    "The script can: JSON.parse(DATA), use loops/map/filter/reduce, Math, string ops, console.log().\n" +
    "The script CANNOT: access files, network, Node.js APIs, or import modules.\n\n" +
    "Example — count serious reactions for a drug:\n" +
    "  tool='fda_drug_events', tool_args={\"search\":\"patient.drug.openfda.brand_name:aspirin\",\"limit\":100},\n" +
    "  code='const d=JSON.parse(DATA);const data=d.data||d;const items=data.items||data.results||[];' +\n" +
    "       'const counts={};items.forEach(r=>{const rxs=r.reactions||[];rxs.forEach(rx=>{counts[rx]=(counts[rx]||0)+1})});' +\n" +
    "       'Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10).forEach(([k,v])=>console.log(k+\": \"+v))'",
  annotations: {
    title: "Code Mode: Process Tool Output",
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    destructiveHint: false,
  },
  parameters: z.object({
    tool: z.string().describe(
      "Name of the MCP tool to call (e.g. 'fda_drug_events', 'fred_series_data', 'congress_search_bills')"
    ),
    tool_args: z.record(z.string(), z.unknown()).optional().describe(
      "Arguments to pass to the tool, as a JSON object (e.g. {\"search\": \"serious:1\", \"limit\": 50})"
    ),
    code: z.string().describe(
      "JavaScript code to process the result. The tool's full response is available as DATA (string). " +
      "Use JSON.parse(DATA) to parse it. Use console.log() to produce output. " +
      "Only console.log output is returned — keep it concise."
    ),
  }),
  execute: async ({ tool: toolName, tool_args: toolArgs, code }, context) => {
    const { reportProgress } = context;
    // Resolve any deprecated alias to the current canonical name
    const resolvedName = TOOL_ALIASES[toolName] ?? toolName;
    const registered = allToolMap.get(resolvedName);
    if (!registered) {
      const available = [...allToolMap.keys()].sort().join(", ");
      return `Error: tool '${toolName}' not found. Available tools: ${available}`;
    }

    // Validate tool_args against the target tool's own schema — the same
    // check FastMCP's normal CallToolRequestSchema handler runs, which this
    // direct execute() call would otherwise skip entirely.
    let validatedArgs: Record<string, unknown> = toolArgs ?? {};
    if (registered.parameters) {
      const parsed = await registered.parameters["~standard"].validate(toolArgs ?? {});
      if (parsed.issues) {
        const friendly = parsed.issues
          .map(issue => `${issue.path?.join(".") || "root"}: ${issue.message}`)
          .join(", ");
        return `Error: invalid tool_args for '${resolvedName}': ${friendly}`;
      }
      validatedArgs = parsed.value as Record<string, unknown>;
    }

    await reportProgress({ progress: 0, total: 2 });

    // Call the underlying tool
    let rawResult: string;
    try {
      const result = await registered.execute(validatedArgs, context);
      rawResult = typeof result === "string" ? result : JSON.stringify(result);
    } catch (err) {
      return `Error calling '${toolName}': ${(err as Error).message}`;
    }

    await reportProgress({ progress: 1, total: 2 });

    // Execute script in sandbox
    const { stdout, beforeBytes, afterBytes, reductionPct, error } =
      await executeInSandbox(rawResult, code);

    await reportProgress({ progress: 2, total: 2 });

    if (error) {
      const previewLen = Math.min(200, rawResult.length);
      const preview = rawResult.length > 200 ? rawResult.slice(0, 200) + "…" : rawResult;
      const argsJson = JSON.stringify(toolArgs ?? {});
      return (
        `Script error: ${error}\n\n` +
        `Called '${toolName}' with args ${argsJson} — returned ${(beforeBytes / 1024).toFixed(1)}KB. ` +
        `Fix the script and try again. The DATA variable contains the tool's raw response as a string.\n\n` +
        `DATA preview (first ${previewLen} chars):\n${preview}`
      );
    }

    const tag = `[code-mode: ${(beforeBytes / 1024).toFixed(1)}KB → ${(afterBytes / 1024).toFixed(1)}KB (${reductionPct.toFixed(1)}% reduction)]`;
    return stdout ? `${stdout}\n\n${tag}` : `(script produced no console.log output)\n${tag}`;
  },
});

// ─── Auto-generate resources ─────────────────────────────────────────

server.addResource({
  uri: "govdata://reference",
  name: "API Reference",
  mimeType: "text/markdown",
  load: async () => {
    const noKey = activeModules.filter(m => !m.auth);
    const withKey = activeModules.filter(m => m.auth);

    // Group keyed APIs by env var
    const keyGroups: Record<string, { envVar: string; signup: string; apis: string[] }> = {};
    for (const m of withKey) {
      const vars = Array.isArray(m.auth!.envVar) ? m.auth!.envVar : [m.auth!.envVar];
      for (const v of vars) {
        if (!keyGroups[v]) keyGroups[v] = { envVar: v, signup: m.auth!.signup, apis: [] };
        keyGroups[v].apis.push(m.displayName);
      }
    }

    // Check which keys are actually configured
    const configuredKeys = Object.keys(keyGroups).filter(k => !!process.env[k]);
    const missingKeys = Object.keys(keyGroups).filter(k => !process.env[k]);

    let md = `# US Government Open Data — API Reference\n\n`;
    md += `**${activeModules.length} APIs loaded** · ${noKey.length} require no key · ${configuredKeys.length}/${Object.keys(keyGroups).length} API keys configured\n\n`;

    // Status section
    if (missingKeys.length) {
      md += `## Missing API Keys\n\n`;
      md += `These APIs are loaded but will fail without keys:\n\n`;
      md += `| Key | APIs Affected | Get Key |\n|---|---|---|\n`;
      for (const k of missingKeys) {
        const g = keyGroups[k];
        md += `| \`${k}\` | ${g.apis.join(", ")} | [Sign up](${g.signup}) |\n`;
      }
      md += `\n`;
    }

    if (configuredKeys.length) {
      md += `## Configured API Keys\n\n`;
      for (const k of configuredKeys) {
        md += `- \`${k}\` → ${keyGroups[k].apis.join(", ")}\n`;
      }
      md += `\n`;
    }

    // Free APIs
    md += `## No Key Required (${noKey.length} APIs)\n\n`;
    md += noKey.map(m => `- **${m.displayName}** (${m.tools.length} tools) — ${m.description.split(".")[0]}.`).join("\n");
    md += `\n\n`;

    // All APIs with tools
    md += `## All APIs & Tools\n\n`;
    for (const m of activeModules) {
      const status = !m.auth ? "No key needed"
        : (Array.isArray(m.auth.envVar) ? m.auth.envVar : [m.auth.envVar]).every(v => !!process.env[v])
          ? "Key configured"
          : "Key missing";
      md += `### ${m.displayName} — ${status}\n\n`;
      md += `${m.tools.length} tools: ${m.tools.map(t => `\`${t.name}\``).join(", ")}\n\n`;
      if (m.workflow) md += `**Workflow:** ${m.workflow}\n\n`;
    }

    return { text: md };
  },
});

// ─── Start ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (transport === "httpStream") {
    await server.start({
      transportType: "httpStream",
      httpStream: {
        port,
        // Bind to localhost only — prevents network exposure.
        // Set MCP_HOST=0.0.0.0 to allow external access (e.g. behind a reverse proxy/PaaS like Railway).
        host: process.env.MCP_HOST ?? "127.0.0.1",
      },
    });
    const host = process.env.MCP_HOST ?? "127.0.0.1";
    console.error(`MCP server listening on http://${host}:${port}/mcp (HTTP Stream)`);
    console.error(`Health check: http://${host}:${port}/health`);
    console.error(`${activeModules.length} modules, ${activeModules.reduce((n, m) => n + m.tools.length, 0)} tools`);
  } else {
    await server.start({ transportType: "stdio" });
  }
}

main().catch(err => {
  console.error("Fatal error starting MCP server:", err);
  process.exit(1);
});

// Railway (and most container platforms) send SIGTERM on every deploy/restart.
// Exit promptly so the platform doesn't wait out its grace period and SIGKILL us
// mid-request.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    console.error(`${signal} received, shutting down...`);
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  });
}
