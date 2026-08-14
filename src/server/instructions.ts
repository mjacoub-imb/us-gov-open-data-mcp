/**
 * Instructions builder — auto-generates the full MCP instructions string from module metadata.
 *
 * The routing table section is derived from each module's `crossRef` hints.
 * Curated content (Code Mode, Rules) is appended unchanged.
 */

import { QUESTION_TYPES, type ApiModule } from "../shared/types.js";
import { CODE_MODE_GUIDE, RULES } from "./curated-guides.js";

/** Optional shaping of the instructions for the grouped tool surface. */
export interface InstructionsOptions {
  /**
   * Facade tool names per module name (see `src/server/facade.ts`). When
   * present, the instructions explain that every tool name mentioned below is
   * an *operation* reached through one of these facades — which is what lets
   * all the existing `workflow`/`tips`/`crossRef` strings stay valid verbatim.
   */
  facadesByModule?: Map<string, string[]>;
  /**
   * Real operation names actually reachable through a surviving facade, per
   * module (see `exposedOperationsByModule` in `src/server/facade.ts`).
   *
   * Only meaningful alongside `facadesByModule`, and only differs from "every
   * tool the module has" when `FACADES`/`FACADES_EXCLUDE` has trimmed the
   * surface below module granularity. A module's `workflow`/`tips`/`crossRef`
   * strings name specific operations by their original tool name — if
   * `FACADES_EXCLUDE` drops the facade one of those operations lives in, the
   * text still names it, but no registered tool can reach it anymore except
   * `code_mode`. Without this, the model is told an operation is callable
   * through a facade that in fact doesn't expose it, and only discovers that
   * by trying and getting a schema-validation error.
   */
  exposedOpsByModule?: Map<string, Set<string>>;
}

/**
 * Build the full MCP instructions string from module metadata.
 *
 * Structure:
 *   0. Calling convention (grouped tool mode only)
 *   1. Per-module blocks (displayName, description, tools, workflow, tips, auth)
 *   2. Auto-generated cross-reference routing table (from crossRef metadata)
 *   3. Code Mode guide (curated)
 *   4. Rules (curated)
 */
export function buildInstructions(modules: ApiModule[], options: InstructionsOptions = {}): string {
  const sections: string[] = [];
  const { facadesByModule, exposedOpsByModule } = options;

  // ── Section 0: Grouped-mode calling convention ──
  if (facadesByModule) sections.push(GROUPED_CALLING_CONVENTION);

  // ── Section 1: Per-module blocks ──
  for (const m of modules) {
    const authNote = m.auth
      ? `Requires ${(Array.isArray(m.auth.envVar) ? m.auth.envVar : [m.auth.envVar]).join(", ")}.`
      : "No key required.";

    // In grouped mode the per-module tool list would duplicate what each
    // facade's own description already carries, so name the facades instead
    // and let the model read the operation list from the tool itself.
    //
    // A module can have grouped mode active but zero surviving facades (every
    // one of its facades dropped by FACADES_EXCLUDE) — `facades` is undefined
    // in that case, NOT because grouped mode is off. Falling back to the
    // full-mode line here would print every one of the module's tool names as
    // if they were directly callable tools, when in fact none of them are
    // registered as anything at all in this deployment.
    const facades = facadesByModule?.get(m.name);
    const toolsLine = !facadesByModule
      ? `Tools: ${m.tools.map((t) => t.name).join(", ")}`
      : facades
        ? `Tools: ${facades.join(", ")} (operations below are called through these)`
        : `Tools: none registered in this deployment. These ${m.tools.length} operations are reachable only via ` +
          `code_mode(tool="<name>", ...): ${m.tools.map((t) => t.name).join(", ")}`;

    // Even when some facades survive, FACADES_EXCLUDE can drop others — the
    // module's workflow/tips/crossRef text below still names their operations
    // by original tool name (that's the whole point of the facade design),
    // but no registered facade can reach them anymore. Name the gap instead
    // of letting the model discover it by getting a schema-validation error.
    const exposedOps = exposedOpsByModule?.get(m.name);
    const hiddenOps = facades && exposedOps
      ? m.tools.map((t) => t.name).filter((name) => !exposedOps.has(name))
      : [];
    const hiddenOpsNote = hiddenOps.length
      ? `Not exposed as operations in this deployment — reachable only via code_mode(tool="<name>", ...): ${hiddenOps.join(", ")}`
      : "";

    sections.push(
      [
        `== ${m.displayName.toUpperCase()} ==`,
        m.description,
        toolsLine,
        hiddenOpsNote,
        m.workflow && `Workflow: ${m.workflow}`,
        m.tips,
        authNote,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  // ── Section 2: Auto-generated routing table ──
  sections.push(buildRoutingTable(modules));

  // ── Sections 3-4: Curated content ──
  sections.push(CODE_MODE_GUIDE);
  sections.push(RULES);

  return sections.join("\n\n");
}

/**
 * Explains the facade indirection once, up front.
 *
 * Every name in the module blocks and the routing table below (e.g.
 * `congress_bill_full_profile`) is an operation, not a tool. Stating the
 * mapping rule here is what keeps ~350 metadata references accurate without
 * rewriting any of them.
 */
const GROUPED_CALLING_CONVENTION = [
  "== HOW TO CALL THESE TOOLS ==",
  "This server exposes one tool per data source rather than one tool per operation.",
  "Every name below that looks like a tool (e.g. congress_search_bills, fda_drug_events, fred_series_data)",
  "is an OPERATION. Call it through its source's tool:",
  "",
  '  congress_bills(operation="congress_search_bills", params={"query":"climate","congress":119})',
  '  fda_drugs(operation="fda_drug_events", params={"search":"...","limit":50})',
  '  fred(operation="fred_series_data", params={"series_id":"GDP"})',
  "",
  "Each source tool's own description lists the operations it accepts.",
  'If you are unsure of an operation\'s arguments, call it with describe=true first —',
  "that returns its full JSON Schema instead of executing it.",
  "code_mode takes the operation name directly in its `tool` argument (no facade needed).",
].join("\n");

/**
 * Auto-generate the cross-reference routing table from module `crossRef` metadata.
 *
 * Groups RouteHints by question type across all modules, producing lines like:
 *   DEBT/DEFICIT → FRED(FYFSGDA188S, GDP) + Treasury(debt_to_penny, avg_interest_rates)
 *
 * Question types are output in QUESTION_TYPES order (topic-clustered),
 * not alphabetically, to preserve the reader-friendly grouping.
 */
function buildRoutingTable(modules: ApiModule[]): string {
  // Collect all hints grouped by question type
  const questionMap = new Map<string, { displayName: string; route: string; primary?: boolean }[]>();

  for (const mod of modules) {
    if (!mod.crossRef) continue;
    for (const hint of mod.crossRef) {
      const key = hint.question;
      if (!questionMap.has(key)) questionMap.set(key, []);
      questionMap.get(key)!.push({
        displayName: mod.displayName,
        route: hint.route,
        primary: hint.primary,
      });
    }
  }

  const lines: string[] = [
    "== CROSS-REFERENCING GUIDE ==",
    'Always cross-reference 2+ sources. Before responding: "What other data would make this more complete?"',
    "",
    "=== ROUTING TABLE ===",
    "Question type \u2192 Primary sources + Enrichment sources",
    "",
  ];

  const fmt = (e: { displayName: string; route: string }) => `${e.displayName}(${e.route})`;

  // Output in QUESTION_TYPES order (topic-clustered, not alphabetical)
  for (const question of QUESTION_TYPES) {
    const entries = questionMap.get(question);
    if (!entries?.length) continue;

    const primary = entries.filter((e) => e.primary);
    if (primary.length === 0) {
      lines.push(`${question.toUpperCase()} \u2192 ${entries.map(fmt).join(" + ")}`);
      continue;
    }

    // A question type this crowded can bury a hint that's genuinely the
    // only correct answer for its sub-case \u2014 pull primary hints out front
    // instead of leaving them at whatever position iteration order put them.
    const rest = entries.filter((e) => !e.primary);
    const primaryStr = `START HERE: ${primary.map(fmt).join(" + ")}`;
    const restStr = rest.length ? ` | Also: ${rest.map(fmt).join(" + ")}` : "";
    lines.push(`${question.toUpperCase()} \u2192 ${primaryStr}${restStr}`);
  }

  return lines.join("\n");
}
