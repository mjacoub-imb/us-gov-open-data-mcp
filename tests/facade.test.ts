/**
 * Tests for grouped tool mode (`src/server/facade.ts`).
 *
 * The properties that matter here are the two that make grouping safe to
 * enable on a live deployment: no tool may be lost in the grouping, and
 * operation names must stay byte-identical to the original tool names (every
 * `workflow`/`tips`/`crossRef` string in the modules depends on that).
 *
 * Delegation and validation are tested against synthetic modules so nothing
 * touches the network.
 */

import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  TOOL_MODES,
  buildFacadeTool,
  buildGroupedTools,
  facadeNamesByModule,
  planFacades,
  validateToolArgs,
} from "../src/server/facade.js";
import type { ApiModule } from "../src/shared/types.js";
import { getModule, getTools, moduleDirs } from "./helpers.js";

// ─── Fixtures ─────────────────────────────────────────────────────────

/** All real modules, as the server would see them. */
const realModules = moduleDirs.map(d => getModule(d) as unknown as ApiModule);

/** Synthetic module with a real Zod schema, for delegation/validation tests. */
function fakeModule(overrides: Partial<ApiModule> = {}): ApiModule {
  return {
    name: "testsrc",
    displayName: "Test Source",
    category: "Economic",
    description: "A test source. Second sentence that should be dropped.",
    workflow: "testsrc_search → testsrc_data",
    tips: "Use testsrc_search first",
    domains: ["economy"],
    tools: [
      {
        name: "testsrc_search",
        description: "Search the test source. Extra detail nobody needs in a facade listing.",
        parameters: z.object({ query: z.string(), limit: z.number().int().max(10).optional() }),
        execute: async (args: any) => `searched:${args.query}:${args.limit ?? "none"}`,
      },
      {
        name: "testsrc_data",
        description: "Get data.",
        parameters: z.object({ id: z.enum(["a", "b"]) }),
        execute: async (args: any) => `data:${args.id}`,
      },
    ] as any,
    ...overrides,
  };
}

/** Build the single facade for a synthetic module. */
function facadeFor(mod: ApiModule) {
  const groups = planFacades([mod]);
  expect(groups).toHaveLength(1);
  return buildFacadeTool(groups[0]);
}

/** Invoke a facade tool's execute with a stub context. */
async function call(tool: any, args: Record<string, unknown>): Promise<string> {
  return (await tool.execute(args, {} as any)) as string;
}

// ─── Coverage: nothing is lost in the grouping ───────────────────────

describe("planFacades — coverage", () => {
  it("assigns every tool of every real module to exactly one group", () => {
    const groups = planFacades(realModules);

    const grouped = groups.flatMap(g => g.tools.map(t => t.name));
    const original = realModules.flatMap(m => m.tools.map(t => t.name));

    expect(grouped).toHaveLength(original.length);
    expect(new Set(grouped).size).toBe(grouped.length); // no tool in two groups
    expect([...grouped].sort()).toEqual([...original].sort());
  });

  it("keeps operation names identical to the original tool names", () => {
    // meta.ts workflow/tips/crossRef strings reference these verbatim.
    const groups = planFacades(realModules);
    for (const group of groups) {
      for (const tool of group.tools) {
        const source = group.module.tools.find(t => t.name === tool.name);
        expect(source, `${tool.name} must come from its own module`).toBeDefined();
      }
    }
  });

  it("never produces a facade name that collides with a real tool name", () => {
    const toolNames = new Set(realModules.flatMap(m => m.tools.map(t => t.name)));
    for (const group of planFacades(realModules)) {
      expect(toolNames.has(group.name), `facade "${group.name}" shadows a tool`).toBe(false);
    }
  });

  it("produces snake_case facade names, like every other tool", () => {
    // Module folders are kebab-case (open-payments); tools never are.
    for (const group of planFacades(realModules)) {
      expect(group.name, `facade "${group.name}"`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("produces unique facade names", () => {
    const names = planFacades(realModules).map(g => g.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("collapses the surface substantially", () => {
    const facades = buildGroupedTools(realModules);
    const toolCount = realModules.reduce((n, m) => n + m.tools.length, 0);
    expect(facades.length).toBeLessThan(toolCount / 4);
  });
});

// ─── Splits ───────────────────────────────────────────────────────────

describe("planFacades — splits", () => {
  it("splits congress into topical facades", () => {
    const congress = realModules.find(m => m.name === "congress");
    if (!congress) return; // module filtered out of this checkout

    const names = planFacades([congress]).map(g => g.name);
    expect(names).toContain("congress_bills");
    expect(names).toContain("congress_members");
    expect(names).toContain("congress_committee_activity");
    expect(names).toContain("congress_nominations_and_treaties");
    expect(names).toContain("congress_records");
  });

  it("routes committee-scoped bill tools to the committee facade, not the bill facade", () => {
    const congress = realModules.find(m => m.name === "congress");
    if (!congress) return;

    const groups = planFacades([congress]);
    const find = (tool: string) => groups.find(g => g.tools.some(t => t.name === tool))?.name;

    expect(find("congress_committee_bills")).toBe("congress_committee_activity");
    expect(find("congress_bill_committees")).toBe("congress_bills");
    expect(find("congress_member_bills")).toBe("congress_members");
  });

  it("leaves unsplit modules as a single facade named after the module", () => {
    const fred = realModules.find(m => m.name === "fred");
    if (!fred) return;

    const groups = planFacades([fred]);
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe("fred");
    expect(groups[0].tools).toHaveLength(fred.tools.length);
  });

  it("maps facade names back to their module", () => {
    const map = facadeNamesByModule(planFacades(realModules));
    for (const mod of realModules) {
      expect(map.get(mod.name)?.length, `${mod.name} has facades`).toBeGreaterThan(0);
    }
  });
});

// ─── Facade description ───────────────────────────────────────────────

describe("buildFacadeTool — description", () => {
  it("lists every operation it accepts", () => {
    const facade = facadeFor(fakeModule());
    expect(facade.description).toContain("testsrc_search");
    expect(facade.description).toContain("testsrc_data");
    expect(facade.description).toContain("Operations (2)");
  });

  it("truncates operation descriptions to the first sentence", () => {
    const facade = facadeFor(fakeModule());
    expect(facade.description).toContain("Search the test source.");
    expect(facade.description).not.toContain("Extra detail nobody needs");
  });

  it("carries the module workflow and auth requirement", () => {
    const facade = facadeFor(
      fakeModule({ auth: { envVar: "TEST_KEY", signup: "https://example.com" } }),
    );
    expect(facade.description).toContain("Workflow: testsrc_search → testsrc_data");
    expect(facade.description).toContain("Requires TEST_KEY");
  });

  it("says no key required for keyless modules", () => {
    expect(facadeFor(fakeModule()).description).toContain("No API key required");
  });
});

// ─── Dispatch ─────────────────────────────────────────────────────────

describe("buildFacadeTool — dispatch", () => {
  it("delegates to the underlying tool", async () => {
    const facade = facadeFor(fakeModule());
    const out = await call(facade, { operation: "testsrc_search", params: { query: "gdp", limit: 5 } });
    expect(out).toBe("searched:gdp:5");
  });

  it("treats omitted params as an empty object", async () => {
    const mod = fakeModule({
      tools: [
        {
          name: "testsrc_ping",
          description: "Ping.",
          parameters: z.object({}),
          execute: async () => "pong",
        },
      ] as any,
    });
    expect(await call(facadeFor(mod), { operation: "testsrc_ping" })).toBe("pong");
  });

  it("rejects params that violate the operation's own schema", async () => {
    const facade = facadeFor(fakeModule());
    const out = await call(facade, { operation: "testsrc_search", params: { query: "gdp", limit: 999 } });
    expect(out).toContain("invalid params for 'testsrc_search'");
    expect(out).toContain("limit");
  });

  it("rejects a missing required param instead of calling the tool", async () => {
    const facade = facadeFor(fakeModule());
    const out = await call(facade, { operation: "testsrc_search", params: {} });
    expect(out).toContain("invalid params for 'testsrc_search'");
  });

  it("rejects an unknown operation with the list of valid ones", async () => {
    const facade = facadeFor(fakeModule());
    const out = await call(facade, { operation: "testsrc_nope" });
    expect(out).toContain("unknown operation");
    expect(out).toContain("testsrc_search");
  });

  it("constrains operation to an enum at the schema level", () => {
    const facade = facadeFor(fakeModule());
    const parsed = (facade.parameters as any).safeParse({ operation: "testsrc_nope" });
    expect(parsed.success).toBe(false);
  });
});

// ─── describe=true ────────────────────────────────────────────────────

describe("buildFacadeTool — describe", () => {
  it("returns the operation's JSON Schema without executing it", async () => {
    const facade = facadeFor(fakeModule());
    const out = JSON.parse(await call(facade, { operation: "testsrc_search", describe: true }));

    expect(out.operation).toBe("testsrc_search");
    expect(out.description).toContain("Search the test source");
    expect(out.params.properties.query.type).toBe("string");
    expect(out.params.required).toContain("query");
  });

  it("preserves enum constraints that the facade schema hides", async () => {
    const facade = facadeFor(fakeModule());
    const out = JSON.parse(await call(facade, { operation: "testsrc_data", describe: true }));
    expect(out.params.properties.id.enum).toEqual(["a", "b"]);
  });

  it("renders a schema for every real operation", async () => {
    // A tool whose schema can't be rendered would leave the model with no way
    // to discover its arguments in grouped mode.
    for (const facade of buildGroupedTools(realModules)) {
      const ops = ((facade.parameters as any).shape.operation.options ?? []) as string[];
      for (const op of ops) {
        const out = JSON.parse(await call(facade, { operation: op, describe: true }));
        expect(out.params, `${op} schema`).toBeDefined();
        expect(out.params.error, `${op} schema render`).toBeUndefined();
      }
    }
  });
});

// ─── validateToolArgs ─────────────────────────────────────────────────

describe("validateToolArgs", () => {
  it("passes args through for tools with no schema", async () => {
    const result = await validateToolArgs({}, { anything: 1 }, "x");
    expect(result).toEqual({ value: { anything: 1 } });
  });

  it("labels the offending argument container", async () => {
    const tool = { parameters: z.object({ n: z.number() }) };
    const result = await validateToolArgs(tool, { n: "no" }, "some_tool", "tool_args");
    expect("error" in result && result.error).toContain("invalid tool_args for 'some_tool'");
  });
});

// ─── Modes ────────────────────────────────────────────────────────────

describe("TOOL_MODES", () => {
  it("exposes exactly the supported surfaces", () => {
    expect([...TOOL_MODES]).toEqual(["full", "grouped"]);
  });
});
