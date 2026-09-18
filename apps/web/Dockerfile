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

# Prisma resolves datasource.url from the environment even for `generate` and
# for `next build`, and refuses to proceed when the variable is absent (P1012).
# This value is a syntactically valid placeholder that is never connected to:
# the build performs no queries, and the runtime stage below does not inherit
# this stage's environment. The real DATABASE_URL reaches the container at
# runtime as a Key Vault secret reference and exists nowhere in this image.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
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
