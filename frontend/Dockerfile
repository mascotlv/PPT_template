FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_STANDALONE=1
ARG BACKEND_URL=http://backend:4100
ENV BACKEND_URL=$BACKEND_URL
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN pnpm install --frozen-lockfile --filter frontend
COPY frontend frontend
COPY scripts/common.mjs scripts/frontend-build.mjs scripts/
RUN pnpm --filter frontend build
FROM node:24.21.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
COPY --from=build --chown=node:node /app/frontend/.next/standalone ./
COPY --from=build --chown=node:node /app/frontend/.next/static ./frontend/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "frontend/server.js"]
