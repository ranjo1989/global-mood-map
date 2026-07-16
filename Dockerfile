# syntax=docker/dockerfile:1
# Global Mood Map — single-process image: Express serves /api + built dist/.
# Build:  docker build -t global-mood-map .
# Run:    docker run -p 8787:8787 -v gmm_data:/app/data global-mood-map

# ---------------------------------------------------------------------------
# Stage 1: build — install everything, bundle the frontend, prune dev deps
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app

# Install with a clean, reproducible tree (cached until the lockfile changes).
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Vite bundles React/MapLibre into dist/ — they're devDependencies on purpose.
RUN npm run build

# Drop dev deps. Runtime deps survive, including geoip-lite and its bundled
# GeoLite2 data files under node_modules/geoip-lite/data.
RUN npm prune --omit=dev

# ---------------------------------------------------------------------------
# Stage 2: runtime — only what the server needs at run time
# ---------------------------------------------------------------------------
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/tsconfig.server.json ./tsconfig.server.json

# Env contract (see docs/DEPLOYMENT.md): PORT, DATA_DIR, SIM, TRUST_PROXY,
# GEO_FALLBACK. Defaults: PORT=8787, DATA_DIR=./data (= /app/data here),
# SIM=on, TRUST_PROXY unset (off), GEO_FALLBACK unset.
EXPOSE 8787

CMD ["node_modules/.bin/tsx", "server/index.ts"]
