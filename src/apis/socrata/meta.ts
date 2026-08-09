/**
 * socrata module metadata.
 */

import { STATE_PORTALS, CITY_PORTALS, FEDERAL_PORTALS } from "./sdk.js";
import type { ModuleMeta } from "../../shared/types.js";

export default {
  name: "socrata",
  displayName: "Socrata Open Data (State & Local)",
  category: "State & Local",
  // NB: in grouped tool-mode the facade ships only the FIRST sentence of this,
  // capped at 300 chars (`firstSentence` in src/server/facade.ts) — and grouped
  // is what the container deploys. Anything the model must see to route
  // correctly has to stay in sentence one, under that cap. The sentence
  // splitter breaks on ". " only, so the "data.ny.gov" domains are safe.
  description: "Cross-portal access to 25+ state and city government open-data portals built on Socrata " +
    "(data.ny.gov, data.nj.gov, opendata.maryland.gov) — the only source here for STATE budgets, " +
    "appropriations and agency expenditures, plus state/local data no federal API carries. " +
    "Also data.texas.gov, data.cityofchicago.org and others: state Medicaid dashboards, DMV records, " +
    "local health inspections, etc.",
  workflow: "socrata_search_datasets to find a dataset (get its id + domain) → socrata_dataset_columns to see field names → socrata_query to pull rows",
  tips: "States confirmed on Socrata: CT, DE, IL, MD, MI, MO, NJ, NY, OR, PA, TX, UT, VT, WA, CO. " +
    "CA, HI, IA, NV, WV, and OK do not run Socrata; see socrata_list_portals for the full verified list. " +
    "Always call socrata_dataset_columns before socrata_query — SoQL needs exact field names, which vary per dataset. " +
    "$where syntax is SQL-like: \"state = 'New York' AND year = 2023\". " +
    "State BUDGET coverage is real but uneven — search the portal before concluding anything. Strong: NY " +
    "(Executive/Enacted appropriations by agency, FY2013-FY2026, e.g. um85-223c), NJ (YourMoney Agency " +
    "Expenditures, apet-rp2i, updated monthly), MD (Operating Budget FY2017-FY2026). Thin: MO has only " +
    "FY2014/15 budget *restrictions* (funds withheld, NOT appropriations), PA only COVID expenditures. " +
    "If a state's portal has no budget dataset, say so rather than substituting federal spending — " +
    "usaspending/treasury cannot answer a state agency budget question.",
  domains: ["economy", "health", "housing", "safety", "transportation", "spending"],
  crossRef: [
    { question: "state-level", route: "socrata_search_datasets (find state agency datasets) → socrata_query (pull rows) — for data federal APIs don't carry" },
    { question: "spending/budget", route: "socrata_search_datasets scoped to that state's portal (e.g. domains:['data.ny.gov'], query:'budget appropriations') → socrata_query — the ONLY source here for STATE agency budgets/appropriations/expenditures. Coverage varies by state; verify before answering" },
  ],
  reference: {
    statePortals: STATE_PORTALS,
    cityPortals: CITY_PORTALS,
    federalPortals: FEDERAL_PORTALS,
    docs: {
      "SODA API Docs": "https://dev.socrata.com/",
      "Discovery API": "https://dev.socrata.com/docs/other/discovery",
      "SoQL Reference": "https://dev.socrata.com/docs/queries/",
    },
  },
} satisfies ModuleMeta;
