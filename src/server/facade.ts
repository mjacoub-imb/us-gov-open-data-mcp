/**
 * Grouped tool mode — collapses the per-source tool set into a handful of
 * facade tools, one per data source (or per topical slice of a large source).
 *
 * Why this exists: the full surface is ~347 tools ≈ 75k tokens of JSON Schema
 * shipped on every `tools/list`, before the model has read the user's question.
 * Grouping cuts that to ~15k without removing a single capability — each
 * underlying tool becomes an `operation` on its source's facade.
 *
 * Two invariants make this safe to turn on for an existing deployment:
 *
 *   1. **Operation names are the original tool names, verbatim.** Every
 *      `workflow`, `tips` and `crossRef` string in the 43 `meta.ts` files
 *      already references names like `congress_bill_full_profile`, and
 *      `instructions.ts` builds the LLM-facing routing table straight from
 *      them. Keeping the names means none of that metadata has to change.
 *   2. **No tool is ever dropped.** Split rules end in a catch-all, so a tool
 *      added later lands in a group even if nobody updates `SPLITS`.
 *
 * `code_mode` is unaffected in either mode: it resolves tools by their real
 * name out of its own map, so it still reaches all 347.
 */

import { z } from "zod";
import type { Tool } from "fastmcp";
import type { ApiModule } from "../shared/types.js";

/** Tool surfaces this server can expose. */
export const TOOL_MODES = ["full", "grouped"] as const;

/** Which tool surface to register. */
export type ToolMode = (typeof TOOL_MODES)[number];

// ─── Split rules for oversized modules ───────────────────────────────

/**
 * A topical slice of one module's tools.
 *
 * Rules are evaluated in order and the first match wins, so put the
 * narrower patterns first (`congress_committee_bills` must reach the
 * committee rule before the bill rule sees it).
 */
interface SplitRule {
  /** Facade tool name. Must not collide with any underlying tool name. */
  name: string;
  /** Short label distinguishing this slice in the facade description. */
  label: string;
  /** Matched against the full tool name. */
  match: RegExp;
}

/**
 * Modules big enough that a single facade would carry an unreadable
 * operation list. Everything not listed here becomes one facade.
 *
 * Each entry's last rule is a catch-all so the split is total.
 */
const SPLITS: Record<string, SplitRule[]> = {
  congress: [
    { name: "congress_committee_activity", label: "committees, hearings, reports, prints & meetings", match: /^congress_(committee|hearing)/ },
    { name: "congress_members", label: "members & floor votes", match: /^congress_(search_members|member_|house_votes|senate_votes)/ },
    { name: "congress_nominations_and_treaties", label: "nominations & treaties", match: /^congress_(nomination|treaty|treaties)/ },
    { name: "congress_bills", label: "bills, amendments & laws", match: /^congress_(search_bills|bill_|amendment|recent_laws|law_details|summaries_search)/ },
    { name: "congress_records", label: "Congressional Record, CRS reports & chamber communications", match: /.*/ },
  ],
  fda: [
    { name: "fda_drugs", label: "drugs", match: /^fda_(drug_|approved_drugs)/ },
    { name: "fda_devices", label: "medical devices", match: /^fda_(device_|covid_serology)/ },
    { name: "fda_food_safety", label: "food, animal & tobacco safety", match: /^fda_(food_|animal_events|tobacco_problems)/ },
    { name: "fda_reference", label: "substance & product reference data", match: /.*/ },
  ],
};

// ─── Grouping ────────────────────────────────────────────────────────

/** One facade's worth of tools. */
export interface FacadeGroup {
  /** The module these tools came from. */
  module: ApiModule;
  /** Facade tool name (the module name, or a `SPLITS` entry name). */
  name: string;
  /** Slice label, present only for split modules. */
  label?: string;
  /** Underlying tools exposed as operations. */
  tools: Tool<any, any>[];
}

/**
 * Assign every tool of every module to exactly one facade group.
 *
 * Throws if a facade name collides with a real tool name or another facade —
 * a collision would silently shadow a capability, and this server's
 * convention is to fail at startup rather than serve a broken surface.
 */
export function planFacades(modules: ApiModule[]): FacadeGroup[] {
  const groups: FacadeGroup[] = [];

  for (const mod of modules) {
    const rules = SPLITS[mod.name];

    if (!rules) {
      if (mod.tools.length) groups.push({ module: mod, name: toToolName(mod.name), tools: mod.tools });
      continue;
    }

    const buckets = new Map<string, Tool<any, any>[]>(rules.map(r => [r.name, []]));
    for (const tool of mod.tools) {
      const rule = rules.find(r => r.match.test(tool.name));
      // Unreachable while every SPLITS entry ends in a catch-all; guard anyway
      // so a bad edit surfaces here instead of dropping tools silently.
      if (!rule) throw new Error(`No split rule in module "${mod.name}" matched tool "${tool.name}" — add a catch-all rule.`);
      buckets.get(rule.name)!.push(tool);
    }

    for (const rule of rules) {
      const tools = buckets.get(rule.name)!;
      if (tools.length) groups.push({ module: mod, name: rule.name, label: rule.label, tools });
    }
  }

  assertNoNameCollisions(modules, groups);
  return groups;
}

/** Facade names per module name — used to explain the calling convention in the instructions. */
export function facadeNamesByModule(groups: FacadeGroup[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const g of groups) {
    const list = map.get(g.module.name) ?? [];
    list.push(g.name);
    map.set(g.module.name, list);
  }
  return map;
}

function assertNoNameCollisions(modules: ApiModule[], groups: FacadeGroup[]): void {
  const toolNames = new Set(modules.flatMap(m => m.tools.map(t => t.name)));
  const seen = new Set<string>();

  for (const g of groups) {
    if (toolNames.has(g.name)) {
      throw new Error(
        `Facade "${g.name}" collides with an existing tool of the same name. ` +
        `Rename the facade in SPLITS (src/server/facade.ts) — operation names are fixed by the modules.`,
      );
    }
    if (seen.has(g.name)) throw new Error(`Duplicate facade name "${g.name}".`);
    seen.add(g.name);
  }
}

// ─── Facade construction ─────────────────────────────────────────────

/** Build the registerable facade tool for one group. */
export function buildFacadeTool(group: FacadeGroup): Tool<any, any> {
  const { module: mod, tools, label } = group;
  const byName = new Map(tools.map(t => [t.name, t]));
  const opNames = [...byName.keys()];

  const authNote = mod.auth
    ? `Requires ${(Array.isArray(mod.auth.envVar) ? mod.auth.envVar : [mod.auth.envVar]).join(", ")} (${mod.auth.signup}).`
    : "No API key required.";

  const description = [
    `${mod.displayName}${label ? ` — ${label}` : ""}. ${firstSentence(mod.description, 300)}`,
    "",
    "Call with operation=<name> and params=<object of that operation's arguments>. " +
    "Set describe=true to get an operation's full JSON Schema before calling it.",
    "",
    `Operations (${opNames.length}):`,
    ...tools.map(t => `- ${t.name}: ${firstSentence(t.description ?? "", 110)}`),
    mod.workflow ? `\nWorkflow: ${mod.workflow}` : "",
    `\n${authNote}`,
  ]
    .filter(Boolean)
    .join("\n");

  return {
    name: group.name,
    description,
    annotations: {
      title: `${mod.displayName}${label ? ` — ${label}` : ""}`,
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
      destructiveHint: false,
    },
    parameters: z.object({
      operation: z
        .enum(opNames as [string, ...string[]])
        .describe(`Which ${mod.displayName} operation to run. See the operation list in this tool's description.`),
      params: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("Arguments for the operation, as a JSON object. Omit for operations that take none."),
      describe: z
        .boolean()
        .optional()
        .describe("Return the operation's JSON Schema and full description instead of executing it."),
    }),
    execute: async ({ operation, params, describe }, context) => {
      const tool = byName.get(operation);
      if (!tool) {
        return `Error: unknown operation '${operation}' for ${group.name}. Available: ${opNames.join(", ")}`;
      }

      if (describe) return describeOperation(tool);

      const validated = await validateToolArgs(tool, params ?? {}, operation, "params");
      if ("error" in validated) return validated.error;

      return tool.execute(validated.value, context) as any;
    },
  };
}

/** Build every facade tool for the given modules. */
export function buildGroupedTools(modules: ApiModule[]): Tool<any, any>[] {
  return planFacades(modules).map(buildFacadeTool);
}

// ─── Operation introspection + validation ────────────────────────────

/**
 * Render one operation's parameter schema as JSON Schema.
 *
 * This is what keeps grouping from being a blind-dispatch downgrade: the
 * per-operation schemas that vanish from `tools/list` stay reachable on
 * demand, one operation at a time instead of all 347 up front.
 */
function describeOperation(tool: Tool<any, any>): string {
  let params: unknown;
  try {
    params = tool.parameters
      ? z.toJSONSchema(tool.parameters as unknown as z.ZodType, { io: "input", unrepresentable: "any" })
      : { type: "object", properties: {} };
  } catch (err) {
    params = { error: `Schema could not be rendered: ${(err as Error).message}` };
  }

  return JSON.stringify({ operation: tool.name, description: tool.description, params }, null, 2);
}

/** Minimal structural view of a tool with a Standard Schema `parameters`. */
interface ValidatableTool {
  parameters?: {
    "~standard": {
      validate: (value: unknown) => Promise<{
        value: unknown;
        issues?: readonly { path?: readonly (string | number)[]; message: string }[];
      }>;
    };
  };
}

/**
 * Run a tool's own Standard Schema over caller-supplied args.
 *
 * Both `code_mode` and the facades call `tool.execute()` directly, bypassing
 * FastMCP's `CallToolRequestSchema` handler — which is where this validation
 * normally happens. Skipping it would leave every tool's enum constraints,
 * numeric bounds and format checks unenforced on those paths.
 */
export async function validateToolArgs(
  tool: unknown,
  args: Record<string, unknown>,
  label: string,
  argName = "arguments",
): Promise<{ value: Record<string, unknown> } | { error: string }> {
  const schema = (tool as ValidatableTool).parameters;
  if (!schema) return { value: args };

  const parsed = await schema["~standard"].validate(args);
  if (parsed.issues) {
    const friendly = parsed.issues
      .map(issue => `${issue.path?.join(".") || "root"}: ${issue.message}`)
      .join(", ");
    return { error: `Error: invalid ${argName} for '${label}': ${friendly}` };
  }

  return { value: parsed.value as Record<string, unknown> };
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Module folder name → MCP tool name.
 *
 * Folders are kebab-case (`open-payments`, `clinical-trials`) but every tool
 * in this server is snake_case, and `module-structure.test.ts` enforces that
 * for module tools — facades shouldn't be the exception.
 */
function toToolName(moduleName: string): string {
  return moduleName.replace(/-/g, "_");
}

/**
 * First sentence of a description, collapsed to one line and length-capped.
 *
 * Tool descriptions are multi-paragraph (they carry examples and field lists);
 * a facade needs enough to route on, not the whole thing — that's where the
 * token savings come from.
 */
function firstSentence(text: string, maxLen: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  const cut = oneLine.split(/(?<=\.)\s/)[0] ?? oneLine;
  const chosen = cut.length > maxLen ? cut.slice(0, maxLen).replace(/\s\S*$/, "") + "…" : cut;
  return chosen;
}
