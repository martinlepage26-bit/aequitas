# syntax=docker/dockerfile:1
# Aequitas production image (CT920 / any plain Docker host).
# Base images come from the AWS ECR Public mirror of Docker Official Images,
# not anonymous Docker Hub (Docker Hub returned 429s on Oct 9 builds).
# Node major follows .nvmrc (22).
ARG NODE_IMAGE=public.ecr.aws/docker/library/node:22-bookworm-slim

FROM ${NODE_IMAGE} AS deps
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

FROM ${NODE_IMAGE} AS runtime
# Same OS packages Railway installs via RAILPACK_DEPLOY_APT_PACKAGES
# (PDF text extraction + OCR in eng/fra).
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils tesseract-ocr tesseract-ocr-eng tesseract-ocr-fra ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app ./
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
