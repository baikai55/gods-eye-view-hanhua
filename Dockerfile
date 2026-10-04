FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
RUN node -e 'const fs=require("fs");const file="package-lock.json";fs.writeFileSync(file,fs.readFileSync(file,"utf8").replaceAll("https://registry.npmjs.org",process.argv[1]));' "$NPM_REGISTRY" \
    && npm ci --registry="$NPM_REGISTRY" --no-audit --no-fund \
    && npm cache clean --force
COPY . .
ARG GOOGLE_MAPS_API_KEY=""
ARG CESIUM_ION_TOKEN=""
RUN GOOGLE_MAPS_API_KEY="$GOOGLE_MAPS_API_KEY" CESIUM_ION_TOKEN="$CESIUM_ION_TOKEN" npm run build
RUN node --test deployment/gateway.test.mjs

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
ENV NODE_ENV=production HOST=127.0.0.1 PORT=4174 GEV_PORT=4173 GEV_UPSTREAM_PORT=4174
COPY --from=build /app /app
RUN mkdir -p /app/.gev-cache /app/.gev-logs /app/node_modules/.vite-temp \
    && chown -R node:node /app/.gev-cache /app/.gev-logs /app/node_modules/.vite-temp
USER node
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:4173/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "deployment/run.mjs"]
