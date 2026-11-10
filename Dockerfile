# syntax=docker/dockerfile:1
# Aequitas production image (CT920 / any plain Docker host).
# Base images come from the AWS ECR Public mirror of Docker Official Images,
# not anonymous Docker Hub (Docker Hub returned 429s on Oct 9 builds).
# Node major follows .nvmrc (22).
# Pin the multi-architecture OCI index digest so CI and deployments use the
# same tested Node base on linux/amd64 and linux/arm64.
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-trixie-slim@sha256:be1e2a3dc2c4fd68cdfadad2a696a280e0d2749098bee509230174d72fb768c6
ARG APP_RUNTIME_IMAGE=ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c
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

FROM ${APP_RUNTIME_IMAGE} AS runtime
ARG APP_RUNTIME_IMAGE
LABEL org.opencontainers.image.base.name="${APP_RUNTIME_IMAGE}"
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 HOME=/home/node
# The production runtime uses a minimal, digest-pinned Ubuntu base. Copy only
# the Node executable from the build image; npm and its dependency tree stay
# out of the shipped app and scheduler image.
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
RUN apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends ca-certificates libatomic1 libgcc-s1 libstdc++6 openssl \
 && rm -rf /var/lib/apt/lists/* \
 && printf 'node:x:1000:1000:Node runtime:/home/node:/usr/sbin/nologin\n' >> /etc/passwd \
 && printf 'node:x:1000:\n' >> /etc/group \
 && mkdir -p /data/evidence /home/node \
 && chown -R 1000:1000 /data /home/node
COPY --from=build --chown=1000:1000 /app ./
COPY --from=production-deps --chown=1000:1000 /app/node_modules ./node_modules
# Deploy-set release: the deploy script passes `git rev-parse HEAD`.
ARG RELEASE_SHA=""
ENV RELEASE_SHA=${RELEASE_SHA}
USER 1000:1000
EXPOSE 3000
# scripts/start.mjs runs `next start` directly (no npm), so SIGTERM from
# `docker stop` is a clean exit 0 (PR #6 behaviour).
STOPSIGNAL SIGTERM
CMD ["node", "scripts/start.mjs"]
