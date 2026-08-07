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
EXPOSE 8080
# node:*-slim ships a non-root "node" user — run as it instead of root.
RUN chown -R node:node /app
USER node
ENTRYPOINT ["node", "dist/server.js"]
