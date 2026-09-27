FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/admin/index.html apps/admin/index.html
COPY apps/admin/tsconfig.json apps/admin/tsconfig.json
COPY apps/admin/vite.config.ts apps/admin/vite.config.ts
COPY apps/admin/src apps/admin/src
RUN pnpm install --filter @m-tunnel/admin --frozen-lockfile
RUN pnpm --filter @m-tunnel/admin build

FROM nginx:alpine
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
RUN chmod -R a+rX /usr/share/nginx/html
