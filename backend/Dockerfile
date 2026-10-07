FROM node:24.21.0-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --filter backend
COPY backend backend
RUN pnpm --filter backend generate && pnpm --filter backend build
RUN pnpm --filter backend deploy --legacy --prod /deploy

FROM build AS migrate
RUN chown -R node:node /app
USER node
WORKDIR /app/backend
ENTRYPOINT ["node", "node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy"]

FROM node:24.21.0-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-cjk && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /deploy/ ./
COPY --from=build --chown=node:node /app/backend/dist ./dist
RUN mkdir -p /data/files /app/.runtime && chown -R node:node /data /app/.runtime
USER node
EXPOSE 4100
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:4100/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
