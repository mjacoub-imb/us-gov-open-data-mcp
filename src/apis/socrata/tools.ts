/**
 * socrata MCP tools.
 */

import { z } from "zod";
import type { Tool } from "fastmcp";
import {
  searchDatasets,
  getDatasetColumns,
  queryDataset,
  STATE_PORTALS,
  CITY_PORTALS,
  FEDERAL_PORTALS,
} from "./sdk.js";
import { listResponse, tableResponse, recordResponse, emptyResponse } from "../../shared/response.js";

export const tools: Tool<any, any>[] = [
  {
    name: "socrata_list_portals",
    description: "List known state, city, and federal government portals that run on Socrata. " +
      "Use this to find the `domain` value for socrata_search_datasets / socrata_query. " +
      "Not exhaustive — many states (CA, HI, IA, NV, WV, OK) use non-Socrata platforms instead.",
    annotations: { title: "Socrata: List Portals", readOnlyHint: true },
    parameters: z.object({}),
    execute: async () => {
      return recordResponse(
        `${Object.keys(STATE_PORTALS).length} state, ${Object.keys(CITY_PORTALS).length} city, ${Object.keys(FEDERAL_PORTALS).length} federal portals`,
        { statePortals: STATE_PORTALS, cityPortals: CITY_PORTALS, federalPortals: FEDERAL_PORTALS },
      );
    },
  },

  {
    name: "socrata_search_datasets",
    description: "Search for datasets across Socrata-hosted government portals by keyword. " +
      "Scope with `domains` (e.g. [\"data.ny.gov\"]) to search a specific state/city, or omit to search all Socrata portals at once. " +
      "Returns each dataset's id and domain — pass both to socrata_dataset_columns and socrata_query.",
    annotations: { title: "Socrata: Search Datasets", readOnlyHint: true },
    parameters: z.object({
      query: z.string().optional().describe("Keyword search, e.g. 'unemployment', 'medicaid enrollment', 'restaurant inspections'"),
      domains: z.array(z.string()).optional().describe("Restrict to these portal hostnames, e.g. ['data.ny.gov', 'data.texas.gov']. Omit to search everywhere."),
      categories: z.array(z.string()).optional().describe("Filter by category, e.g. ['Health', 'Education']"),
      tags: z.array(z.string()).optional().describe("Filter by tag"),
      limit: z.number().int().max(100).default(20).describe("Max results (default 20)"),
    }),
    execute: async ({ query, domains, categories, tags, limit }) => {
      const { results, total } = await searchDatasets({ q: query, domains, categories, tags, limit });
      if (!results.length) return emptyResponse(`No datasets found${query ? ` for "${query}"` : ""}.`);
      return listResponse(
        `${results.length} of ${total} datasets${query ? ` matching "${query}"` : ""}`,
        { items: results, total },
      );
    },
  },

  {
    name: "socrata_dataset_columns",
    description: "Get the schema (field names, types, descriptions) for a dataset on a Socrata portal. " +
      "Call this BEFORE socrata_query — SoQL queries require exact field names, which vary per dataset.",
    annotations: { title: "Socrata: Dataset Columns", readOnlyHint: true },
    parameters: z.object({
      domain: z.string().describe("Portal hostname, e.g. 'data.ny.gov'"),
      dataset_id: z.string().describe("Dataset four-by-four ID, e.g. 'w8eu-45mn'"),
    }),
    execute: async ({ domain, dataset_id }) => {
      const { name, description, columns } = await getDatasetColumns(domain, dataset_id);
      if (!columns.length) return emptyResponse(`No columns found for dataset ${dataset_id} on ${domain}.`);
      return tableResponse(
        `${name}: ${columns.length} columns`,
        { rows: columns, meta: { description } },
      );
    },
  },

  {
    name: "socrata_query",
    description: "Run a SoQL query against a dataset on any Socrata portal (SODA API $-parameters). " +
      "Get the domain/dataset_id from socrata_search_datasets and field names from socrata_dataset_columns first.\n" +
      "$where example: \"state = 'New York' AND year = 2023\". $select example: \"state, year, count(*)\".",
    annotations: { title: "Socrata: Query Dataset", readOnlyHint: true },
    parameters: z.object({
      domain: z.string().describe("Portal hostname, e.g. 'data.ny.gov'"),
      dataset_id: z.string().describe("Dataset four-by-four ID, e.g. 'w8eu-45mn'"),
      select: z.string().optional().describe("SoQL $select clause, e.g. 'state, year, count(*)'"),
      where: z.string().optional().describe("SoQL $where clause, e.g. \"state = 'New York'\""),
      group: z.string().optional().describe("SoQL $group clause"),
      having: z.string().optional().describe("SoQL $having clause"),
      order: z.string().optional().describe("SoQL $order clause, e.g. 'year DESC'"),
      q: z.string().optional().describe("Full-text search across the dataset"),
      limit: z.number().int().max(50000).default(1000).describe("Max rows (default 1000)"),
      offset: z.number().int().optional().describe("Row offset for pagination"),
    }),
    execute: async ({ domain, dataset_id, select, where, group, having, order, q, limit, offset }) => {
      const data = await queryDataset(domain, dataset_id, { select, where, group, having, order, q, limit, offset });
      if (!data.length) return emptyResponse(`No records found for dataset ${dataset_id} on ${domain}.`);
      return tableResponse(
        `${data.length} records from ${dataset_id} on ${domain}`,
        { rows: data },
      );
    },
  },
];
