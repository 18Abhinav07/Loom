# Loom daemon + dashboard. Local: `docker compose up`. Deployed (read-only demo): LOOM_READONLY=1 LOOM_TENANT=public LOOM_AUTOREPLAY=demo/run-1.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
  && corepack enable && git config --global user.email loom@local && git config --global user.name loom
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm -s build:ui && pnpm -s build:cli
ENV LOOM_HOST=0.0.0.0 FALKORDB_URL=redis://falkordb:6379
EXPOSE 4317 4318
CMD ["node", "node_modules/tsx/dist/cli.mjs", "packages/daemon/src/server.ts"]
