# ADR 0010: Repo and release tooling. Changesets releases, a checked public-API report, package checks on the built artifact, and a real-Postgres CI run

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** 9
- **Amends:** ADR 0007 (concurrent `migrate()`; see "What the real-Postgres run found")

## Context

Usher is a security library that other companies will put between their
customers and third-party agents. Its release process has to prove a few
things on every change, automatically:

1. **The behavior holds**, on every supported runtime and OS, including the
   concurrency claims ADR 0007 could only argue from SQL semantics.
2. **The public API changes only on purpose**, and semver says so.
3. **The published artifact works.** Tests run against `src/`, but users get
   `dist/`: the exports map, the edge-safe main entry (ADR 0008) and the
   served elements script (ADR 0009) can all break in the build alone.
4. **The supply chain is boring**: pinned dependencies and actions, no
   surprise install scripts, provenance on what we publish.

## Options considered

### Versioning and changelogs
- **semantic-release** (versions from commit messages): fully automatic, but
  the changelog is only as good as commit subjects, and the release happens
  on merge with no review step.
- **release-please** (from conventional commits, via a release PR): reviewable,
  but still commit-message-driven.
- **Changesets** (chosen): each PR carries a small human-written changeset
  with its bump. They accumulate into a "Version packages" PR, and merging
  it publishes. The changelog is written for users, and the release is a
  reviewed diff. It's the standard for pnpm monorepos.

### Public API guard
- **API Extractor**: thorough, but heavy configuration per entry point, and
  it fights multi-entry ESM packages.
- **Type tests only**: catch breaks we thought of, not ones we didn't.
- **A small report generator over the built `.d.ts`** (chosen): every export
  of every entry point is printed without comments into
  `api/<entry>.api.md`. CI fails if the report is stale, so any public
  surface change shows up as a reviewable diff.

### Lint and format
- **ESLint + Prettier**: two tools and configs, slow on Windows.
- **Biome** (chosen): one fast binary that formats, lints and sorts imports,
  with the recommended rules.

### Concurrency testing
- **A Docker Postgres service in CI**: Linux runners only, and contributors
  need Docker locally.
- **embedded-postgres** (chosen): it downloads the official Postgres
  binaries per platform and starts a real server from the test. It runs the
  same on Linux, macOS and Windows, in CI and on a laptop, with no Docker.

## Decision

| Area | Choice |
|---|---|
| CI (`.github/workflows/ci.yml`) | A **check** job (Ubuntu, Node 24): Biome with warnings as errors, typecheck, build, API report check, package check, and a changeset required on PRs. Then a **test** matrix: Ubuntu, Windows and macOS × Node 22 and 24 |
| Releases (`release.yml`) | Changesets on `main` opens or updates "Version packages". Merging it runs tests, rebuilds, re-runs the API and package checks on the exact files, and publishes with npm provenance |
| Semver while `0.x` | **minor** for any breaking change to the API report, the stored data or security behavior. **patch** for everything else (`.changeset/README.md`) |
| API report | `scripts/api-report.mjs`, built on the TypeScript compiler API over `dist/*.d.ts`, writes `packages/core/api/*.api.md`. `--check` in CI |
| Package check | `scripts/check-package.mjs` verifies: every export and the bin resolve, and the bin has a shebang; the main entry's import graph contains **no `node:` import** (edge-safe, ADR 0008); and the **minified** elements script registers both elements and renders in a DOM, under a 14 KB budget. Plus **publint --strict** and **attw** (ESM-only profile) |
| Elements minification | `scripts/postbuild.mjs` minifies the same `installUsherElements` function with esbuild into `dist/ui/elements-script.js`: 18.1 KB → 11.1 KB. From source it stays the unminified function text |
| Concurrency | `test/postgres-concurrency.test.ts` starts a real Postgres 18 server and races 24 pooled connections on code consumption, refresh rotation, approval decide and consume, rate-limit counting, grant revocation, and `migrate()` on a fresh database |
| Formatting and lint | Biome, 140 columns. Markdown is excluded, so accepted ADRs are never rewritten. Each lint suppression carries a `biome-ignore` reason in the code |
| Line endings | `.gitattributes` `* text=auto eol=lf`, plus `.editorconfig` |
| Supply chain | Exact versions everywhere. New versions are adopted after a 14-day cooling-off (Dependabot `cooldown`). GitHub Actions are pinned to commit SHAs, with versions in comments, and kept current by Dependabot. Install scripts are allowed only for esbuild and embedded-postgres, both reviewed (`onlyBuiltDependencies`) |
| Runtime support | `engines: node >=22.13` (`node:sqlite` unflagged). Node 20 is end-of-life |
| Repo | MIT `LICENSE`, `SECURITY.md` (GitHub private vulnerability reporting, scope, timelines), `CONTRIBUTING.md` (ADR rule, API reports, mutation-checking guards, dependency policy) |

## What the real-Postgres run found

The first run failed. Several instances calling `migrate()` at the same
moment on a fresh database crashed one of them with
`duplicate key value violates unique constraint "pg_type_typname_nsp_index"`.
On Postgres, `CREATE TABLE IF NOT EXISTS` isn't safe against a concurrent
`CREATE` of the same table.

**ADR 0007's claim that migrations are "safe from several instances at once"
was wrong.** It's corrected here; ADR 0007 itself is left as written.

- **Fix:** `migrate()` retries a run that loses this race. The retry covers
  the Postgres codes `23505`, `42P07` and `42710`, up to 8 times with
  backoff. Every statement is idempotent, so the retry finds the winner's
  tables in place.
- **Why not an advisory lock:** session-level locks need a pinned
  connection, and the `SqlExecutor` contract (ADR 0007) deliberately
  doesn't have one. A lock taken on one pooled connection could be released
  on another.
- **Verified:** with the retry disabled, the test fails 3 runs out of 3. With
  it, the suite passes repeatedly.

Every security-relevant atomic operation held under real parallelism:

- exactly 1 of 24 concurrent consumers wins a code or a refresh token, and
  all 23 losers see a replay;
- exactly one of 24 conflicting approve/deny decisions sticks, and the
  stored status matches the winner;
- an approval is consumed once;
- 24 concurrent rate-limit hits count exactly 1…24;
- a concurrent scope update never resurrects a revoked grant.

## Why

1. **Check what ships, not just what's tested.** Three Usher features exist
   only in the build: the exports map, the edge-safe entry and the minified
   script. `check-package.mjs` exercises the artifact itself, and the release
   job re-runs it on the exact files being published.
2. **Make API changes impossible to miss.** For a library whose public
   surface includes security contracts, a visible diff in review is the
   cheapest guard there is. A plain-text report needs no tooling to read.
3. **Releases are reviewed like code.** Changesets turn "what changed for
   users" into an explicit artifact on each PR, and publishing into a merge
   of a reviewable PR.
4. **Real engines, everywhere, without infrastructure.** embedded-postgres
   gave a true multi-connection server on Windows in a unit test. That is
   how it found a bug that PGlite and SQLite structurally couldn't.
5. **Boring supply chain.** Exact pins, cooling-off, SHA-pinned actions,
   allowlisted install scripts and provenance close the common paths by
   which a library like this gets compromised.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| Fully automatic releases | Someone has to merge "Version packages" | Intentional: a human looks at the changelog and bump before anything reaches npm |
| A complete type-level API diff | The report prints exported declarations. A change confined to a *non-exported* type they reference shows up only as its name | Most public types are exported. Promote referenced types to exports when they matter |
| CI time | The 6-cell test matrix plus a Postgres download (cached per runner) adds minutes | `fail-fast: false` for signal, cancellation of superseded PR runs |
| An npm token secret | Publishing uses `NPM_TOKEN` + provenance | Move to npm trusted publishing (OIDC, no long-lived token) once it's confirmed with `changeset publish` under pnpm |
| Retry instead of a lock in `migrate()` | Under extreme contention, 8 attempts could still be exhausted | Each attempt is a few idempotent statements, and losers back off. Teams that want strictness run `npx usherjs sql` in their own migration tool (ADR 0007) |
| Node 22.12 and older | Not supported | 22.13+ and 24 are what's maintained in November 2026 |
| Biome's recommended rules | Slightly different defaults than the ESLint ecosystem | Suppressions are rare and justified inline |

## What was built in this phase

```text
.github/workflows/ci.yml        check job + OS × Node test matrix
.github/workflows/release.yml   Changesets version PR / publish with provenance
.github/dependabot.yml          SHA-pinned actions and npm, 14-day cooldown
.changeset/                     config, contributor guide, first-release changeset (0.1.0)
packages/core/scripts/          postbuild.mjs (minify), api-report.mjs, check-package.mjs
packages/core/api/*.api.md      public API reports for all five entry points
packages/core/test/postgres-concurrency.test.ts
biome.json, .gitattributes, .editorconfig, .nvmrc, LICENSE, SECURITY.md, CONTRIBUTING.md
```

- `migrate()` retries concurrent-create races (see above).
- The served elements script moved to `src/ui/elements-script.ts`, so the
  build can replace it with the minified copy.
- Package metadata: `engines`, `sideEffects` (only `usherjs/elements`
  registers anything), `keywords`, `LICENSE`.
- Scripts: `pnpm verify` runs everything CI runs, locally. Also `pnpm lint`,
  `pnpm format`, `pnpm changeset`, `pnpm --filter usherjs api`.
- Tests: 185 total, 6 new (the real-Postgres concurrency run). The full
  `pnpm verify` passes locally.
- **Checked by breaking things:**
  - disabling the migrate retry fails the concurrency test (3 of 3 runs);
  - planting a `node:fs` import in the built main entry fails the package
    check, naming the import chain;
  - the API check failed on a real signature change made during this
    phase's lint fixes (`sqliteExecutor`'s parameter type), and passed once
    the report was regenerated.

## Revisit when

- npm trusted publishing works end-to-end with `changeset publish` → drop
  `NPM_TOKEN`.
- A second package joins the monorepo → decide `fixed` vs independent
  versioning in `.changeset/config.json`.
- The API report misses a break in review → switch to API Extractor, or add
  referenced-type expansion.
- 1.0 → normal semver: breaking changes go to majors.
