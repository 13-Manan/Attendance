# ATTENDANCE PROJECT — production image for apps/web (Next.js 16.3.5)
#
# Build from the REPOSITORY ROOT, not from apps/web:
#   docker build -f apps/web/Dockerfile -t attendance-web .
#   az acr build -r attendanceprodacr -f apps/web/Dockerfile -t web:<sha> .
#
# The context has to be the root because this is an npm-workspaces monorepo:
# the lockfile, packages/shared-types and the hoisted node_modules all live
# above apps/web, and a context rooted at apps/web cannot see any of them.
#
# Debian slim rather than Alpine, deliberately. Prisma ships a different query
# engine for musl than for glibc, and a mismatch between the image that runs
# `prisma generate` and the image that runs the server surfaces at runtime as
# an unreadable engine error on the first query — i.e. after a deploy has
# already been called successful. The ~40 MB saved is not worth that class of
# bug in a production attendance system.

# ---------------------------------------------------------------------------
# deps — install once, from the lockfile, and cache this layer
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /repo

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Only the manifests, so a source-only change does not invalidate the install.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json

# `npm ci` and not `npm install`: it installs exactly the lockfile and fails if
# the manifests have drifted from it, which is the behaviour you want in a
# build that nobody is watching.
RUN npm ci

# ---------------------------------------------------------------------------
# build — generate the Prisma client, then compile
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /repo
COPY . .

# Build-time placeholders for every variable apps/web/src/lib/env.ts validates.
#
# That module calls envSchema.parse() at import time so a misconfigured
# deployment dies at boot rather than mid-request. `next build` imports it while
# collecting page data for the route handlers, so the build needs all four
# present or it fails — which is what it did before these were added. Prisma
# has the same requirement independently: it resolves datasource.url from the
# environment even for `generate`, and errors with P1012 when it is absent.
#
# These values are placeholders, not secrets, and they cannot leak or take
# effect in production for two independent reasons:
#
#   1. Next.js inlines only NEXT_PUBLIC_* variables. Server-side reads stay as
#      `process.env.X` lookups in the emitted standalone output — verified
#      against a build made with real values, which baked in none of them — so
#      the running container reads its real configuration, never these.
#   2. The runtime stage below is a fresh FROM and inherits none of this
#      stage's environment.
#
# The real values reach the container at runtime as Key Vault secret
# references and exist nowhere in this image.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
ENV FACE_AI_SERVICE_URL="http://127.0.0.1:8000"
ENV AUTH_SECRET="build-time-placeholder-not-a-secret"
ENV API_KEY_PEPPER="build-time-placeholder-not-a-secret"
ENV NEXT_TELEMETRY_DISABLED=1

RUN npx prisma generate --schema=apps/web/prisma/schema.prisma
RUN npm run build --workspace=web

# ---------------------------------------------------------------------------
# runtime — standalone output only
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
# Without this the server binds 127.0.0.1 and the Container Apps ingress probe
# cannot reach it, which presents as a healthy-looking revision that never
# takes traffic.
ENV HOSTNAME=0.0.0.0

# `output: "standalone"` emits a self-contained tree with only the traced
# subset of node_modules, so no install happens here. `static` and `public`
# are not included by that tree and must be copied alongside it.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

# Container Apps sends SIGTERM and waits before SIGKILL. Running node as PID 1
# with exec form means the signal reaches the process rather than a shell, so
# in-flight attendance submissions finish instead of being cut off.
CMD ["node", "apps/web/server.js"]
