# Single image for all Node services (api / worker / scheduler). They differ only by the
# start command, set per-service in docker-compose. We run TypeScript directly via tsx —
# no separate build step to drift out of sync with source (justified in DESIGN.md §0).
FROM node:20-alpine

WORKDIR /app

# Install dependencies first for better layer caching. Copy every workspace's package.json
# so npm can resolve the workspace graph, then install once.
COPY package.json package-lock.json ./
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/worker/package.json ./packages/worker/package.json
COPY packages/scheduler/package.json ./packages/scheduler/package.json
COPY packages/api/package.json ./packages/api/package.json
RUN npm ci

# Copy the rest of the source.
COPY . .

# Default command; overridden by each compose service. We invoke node directly (with the
# tsx loader) rather than via `npm start`, so NODE is PID 1 / the signal target and
# receives SIGTERM from `docker stop` — essential for graceful shutdown / job draining.
CMD ["node", "--import", "tsx", "packages/worker/src/main.ts"]
