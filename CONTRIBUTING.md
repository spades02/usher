# Contributing

## Setup

You need Node 22.13+ (24 recommended; see `.nvmrc`) and pnpm 10.

```sh
pnpm install
pnpm verify    # lint, types, build, API reports, package checks, tests
```

The tests include a real Postgres server, started from official binaries by
`embedded-postgres`. You don't need Docker or a local database.

| Command | |
|---|---|
| `pnpm test` | All tests |
| `pnpm format` | Format and auto-fix lint (Biome) |
| `pnpm --filter usherjs api` | Regenerate `packages/core/api/*.api.md` after a public API change |
| `pnpm changeset` | Describe your change for the changelog |

## How changes are made

- **Architectural decisions get an ADR** in `docs/adr/`. Accepted ADRs are
  never edited: a new decision supersedes an old one in a new ADR.
- **Public API changes are visible in review.** CI fails if the
  `api/*.api.md` reports are stale. Regenerate them, and pick the semver bump
  in your changeset accordingly (`.changeset/README.md`).
- **Security behavior is mutation-checked.** When you add a guard (a scope
  check, an origin check, an escape), break it on purpose and confirm a test
  fails. A guard no test notices isn't a guard.
- **Dependencies are pinned exactly**, and new versions wait two weeks
  before adoption. Install scripts are allowed only for the packages listed
  in `pnpm-workspace.yaml`.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Please don't use public issues for them.
