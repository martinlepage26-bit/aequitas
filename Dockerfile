# syntax=docker/dockerfile:1
# Aequitas production image (CT920 / any plain Docker host).
# Base images come from the AWS ECR Public mirror of Docker Official Images,
# not anonymous Docker Hub (Docker Hub returned 429s on Oct 9 builds).
# Node major follows .nvmrc (22).
# Pin the multi-architecture OCI index digest so CI and deployments use the
# same tested Node base on linux/amd64 and linux/arm64.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6
ARG NPM_VERSION=11.21.2

FROM ${NODE_IMAGE} AS node-base
ARG NODE_IMAGE
ARG NPM_VERSION
ENV DEBIAN_FRONTEND=noninteractive
# The digest pins the Node base; Debian security fixes published after it
# (e.g. zlib1g 1:1.3.dfsg+really1.3.1-1+deb13u1) arrive only via apt, so
# apply them here. Every later stage, including runtime, builds on this one.
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global "npm@${NPM_VERSION}" --no-audit --no-fund

FROM node-base AS deps
WORKDIR /app
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# postinstall runs `prisma generate`
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate && npm run build
# Do not copy the build-stage dependency tree into runtime. The production
# stage installs its own locked, dev-omitted node_modules below.
RUN rm -rf node_modules

FROM node-base AS production-deps
WORKDIR /app
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# The deployment image needs Prisma CLI for migrations and tsx for scheduled
# operations; those are declared as runtime dependencies. Keep dev/test tools
# out of the customer-facing app and scheduler image.
RUN npm ci --omit=dev --no-audit --no-fund

FROM node-base AS runtime
LABEL org.opencontainers.image.base.name="${NODE_IMAGE}"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app ./
COPY --from=production-deps --chown=node:node /app/node_modules ./node_modules
RUN mkdir -p /data/evidence && chown -R node:node /data
# Deploy-set release: the deploy script passes `git rev-parse HEAD`.
ARG RELEASE_SHA=""
ENV RELEASE_SHA=${RELEASE_SHA}
USER node
EXPOSE 3000
# scripts/start.mjs runs `next start` directly (no npm), so SIGTERM from
# `docker stop` is a clean exit 0 (PR #6 behaviour).
STOPSIGNAL SIGTERM
CMD ["node", "scripts/start.mjs"]
