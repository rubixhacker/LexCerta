FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY .nvmrc tsconfig.json tsconfig.postgres.json tsconfig.node.json worker-configuration.d.ts ./
COPY src ./src
COPY scripts/check-runtime.mjs ./scripts/check-runtime.mjs
RUN npm run runtime:check && npm run build:node && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
WORKDIR /app
ENV NODE_ENV=production PORT=8080
ARG BUILD_ID
ENV LEXCERTA_BUILD_ID=$BUILD_ID
LABEL org.opencontainers.image.revision=$BUILD_ID
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/build ./build
COPY --chown=node:node database/migrations ./database/migrations
USER node
EXPOSE 8080
CMD ["node", "build/node/public-main.js"]
