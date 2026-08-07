/**
 * socrata module metadata.
 */

import { STATE_PORTALS, CITY_PORTALS, FEDERAL_PORTALS } from "./sdk.js";
import type { ModuleMeta } from "../../shared/types.js";

export default {
  name: "socrata",
  displayName: "Socrata Open Data (State & Local)",
  category: "State & Local",
  description: "Cross-portal access to state and city government open-data platforms built on Socrata " +
    "(data.ny.gov, data.texas.gov, data.cityofchicago.org, and 20+ others) — for state/local datasets " +
    "that never make it into federal APIs (state Medicaid dashboards, DMV data, local health inspections, etc.)",
  workflow: "socrata_search_datasets to find a dataset (get its id + domain) → socrata_dataset_columns to see field names → socrata_query to pull rows",
  tips: "Not every state runs Socrata — CA, HI, IA, NV, WV, and OK do not; see socrata_list_portals for the verified list. " +
    "Always call socrata_dataset_columns before socrata_query — SoQL needs exact field names, which vary per dataset. " +
    "$where syntax is SQL-like: \"state = 'New York' AND year = 2023\".",
  domains: ["economy", "health", "housing", "safety", "transportation"],
  crossRef: [
    { question: "state-level", route: "socrata_search_datasets (find state agency datasets) → socrata_query (pull rows) — for data federal APIs don't carry" },
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
