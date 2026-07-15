FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/common/package.json packages/common/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/client/package.json packages/client/package.json

RUN pnpm install --frozen-lockfile

COPY packages/common packages/common
COPY packages/server packages/server

RUN pnpm build:server

FROM node:24-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY --from=build --chown=node:node /app/packages/server/dist/index.cjs ./server.cjs

USER node
EXPOSE 3000

CMD ["node", "server.cjs"]
