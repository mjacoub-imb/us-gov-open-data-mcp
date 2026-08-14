FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist/ dist/
ENV MCP_TRANSPORT=httpStream
ENV MCP_HOST=0.0.0.0
# Container = remote clients paying for tools/list over the wire, so group the
# tool surface (~52 facades instead of ~347 tools: ~348K chars -> ~113K). Local
# stdio users are unaffected — server.ts still defaults to `full`. Nothing is
# removed; each tool stays reachable as an `operation` (see server/facade.ts).
ENV TOOL_MODE=grouped
# Load only the modules this deployment actually researches with (PE diligence:
# utility/infrastructure/energy-services). The other 27 stay in the image and
# on disk — they are simply not registered, so they cost no tools/list bytes.
# Drop a name here and it disappears from the model's context; add it back and
# it returns, no rebuild of the module needed.
#
#   fred,treasury,bea  rate environment + macro underwriting context
#   eia                energy/grid load-growth data
#   sec                public comps for infra-services valuation
#   usaspending        govcon revenue screening (federal vs. state/local exposure)
#   federal-register,regulations,congress
#                      infrastructure/grid-hardening regulatory + legislative tracking
#   dol                labor/wage benchmarking (labor-shortage thesis)
#   socrata            state & local portals — incl. STATE budgets/appropriations
#   nhtsa,bts          fleet/trucking components
#   uspto              proprietary tech/IP diligence
#   census,hud         geographic market-expansion analysis
#
# `congress` alone is ~22K chars of the ~80K preamble (71 operations across 5
# facades) — it is the first thing to cut if more headroom is needed.
ENV MODULES=fred,treasury,bea,eia,sec,usaspending,federal-register,regulations,congress,dol,socrata,nhtsa,bts,uspto,census,hud
# `congress` is loaded only to track infrastructure/energy legislation STATUS,
# which congress_bills covers on its own (bill text, status, sponsors). The
# other four facades are a different job and are not part of the deal workflow:
#   congress_committee_activity     hearings/markup — only for tracking a bill live through committee
#   congress_members                floor votes by member — political mapping, not diligence
#   congress_nominations_and_treaties  no relevance to deal work
#   congress_records                Congressional Record/CRS — too granular
# MODULES cannot express this (it is all-or-nothing per module), hence FACADES_EXCLUDE.
# Dropped operations stay reachable via code_mode by name, at zero tools/list cost.
ENV FACADES_EXCLUDE=congress_committee_activity,congress_members,congress_nominations_and_treaties,congress_records
EXPOSE 8080
# node:*-slim ships a non-root "node" user — run as it instead of root.
RUN chown -R node:node /app
USER node
ENTRYPOINT ["node", "dist/server.js"]
