# Build the SPA, then serve the static bundle with nginx (SPA fallback in nginx.conf).
# The browser calls the API directly at VITE_API_URL (default http://localhost:4000),
# so no API proxy is needed here.
FROM node:20-alpine AS build
WORKDIR /app
# Copy the workspace manifests so `npm ci` can resolve the graph, then install.
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/shared/package.json ./packages/shared/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/worker/package.json ./packages/worker/package.json
COPY packages/scheduler/package.json ./packages/scheduler/package.json
COPY packages/api/package.json ./packages/api/package.json
RUN npm ci
COPY . .
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build -w @codity/frontend

FROM nginx:alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
EXPOSE 80
