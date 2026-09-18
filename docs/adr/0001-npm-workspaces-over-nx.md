# ADR-0001: npm workspaces, not Nx/Turborepo

## Status

Accepted (foundation phase).

## Context

The repo needs to hold one Next.js app, one small shared-types package, and
(in a separate language/package manager entirely) one Python service. A
monorepo tool decision has to be made before scaffolding.

## Decision

Use plain npm workspaces (`apps/*`, `packages/*`). No Nx, no Turborepo, no
pnpm.

## Rationale

Nx and Turborepo earn their keep with many interdependent JS/TS packages,
remote build caching needs, and complex task graphs. None of that exists
yet: there is exactly one app and one package that depends on it. npm
workspaces (native to npm ≥7, zero additional dependency) already gives
hoisted `node_modules` and cross-package resolution
(`@attendance/shared-types` resolves into `apps/web` for free). Adding
heavier tooling now would be exactly the "unnecessary dependency" the
project's own constraints warn against.

## Revisit trigger

Reconsider Turborepo (not Nx — Turborepo is the lighter-weight option and
sufficient for build-graph caching) if a second JS/TS app is added (e.g. an
admin dashboard or a mobile shell) and `npm run build` across all workspaces
becomes slow enough that caching/parallelization has measurable value.
