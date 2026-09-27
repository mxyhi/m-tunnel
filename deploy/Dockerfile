FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/workspace-tools/package.json packages/workspace-tools/package.json
RUN pnpm install --prod --frozen-lockfile
COPY apps/api/dist apps/api/dist
COPY packages/db/dist packages/db/dist
COPY packages/protocol/dist packages/protocol/dist
COPY packages/workspace-tools/dist packages/workspace-tools/dist
RUN mkdir -p /app/data
ENV NODE_ENV=production PORT=18290 DB_FILE=/app/data/m-tunnel.sqlite
EXPOSE 18290
CMD ["node", "apps/api/dist/server.js"]
