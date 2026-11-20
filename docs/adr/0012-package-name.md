# ADR 0012: Package name. Publish as `@usherjs/core`

- **Status:** Accepted
- **Date:** 2026-11-20
- **Phase:** First release
- **Amends:** every earlier ADR that names the package `usherjs`

## Context

ADRs 0001–0011 call the package `usherjs`, with subpaths such as
`usherjs/node` and the CLI as `npx usherjs …`. The first publish was
refused by npm: the name is "too similar to existing package `usher-js`".
npm's similarity rule ignores punctuation, so no spelling of `usherjs` can
be published unscoped. Nothing had been published, so nobody depends on the
old name.

## Options considered

1. **`@usherjs/core` under an npm organization (chosen).**
   - ✅ Scoped names skip the similarity check, and the scope belongs to the
     project rather than a person.
   - ✅ It leaves room for more packages later (`@usherjs/elements`, adapters)
     without another rename.
   - ❌ Longer to type, and the CLI becomes `npx @usherjs/core …`.
2. **A personal scope (`@spades02/usherjs`).** It works with no setup, but
   it ties the package to one account, and moving it to an organization
   later means renaming again after people depend on it.
3. **Another unscoped name (`usher-mcp`).** Short, but npm might also find
   it too similar to another name, and that is only known at publish time.

## Decision

| Before | After |
|---|---|
| `usherjs` | `@usherjs/core` |
| `usherjs/node`, `/standalone`, `/elements`, `/testing` | `@usherjs/core/node`, and so on |
| `npx usherjs doctor` / `serve` / `sql` | `npx @usherjs/core doctor` / `serve` / `sql` |
| `api/usherjs*.api.md` | `api/usherjs__core*.api.md` |

- The installed binary keeps the name `usherjs`, so `pnpm usherjs doctor`
  works inside a project. The docs use `npx @usherjs/core …`, which works
  whether or not the package is installed.
- `publishConfig.access` is `public`, because scoped packages default to
  private.
- The docs, samples, CI, release scripts and code comments use the new
  name. Earlier ADRs are left as written, and this ADR is the mapping.

## Trade-offs

| We give up | Impact | Mitigation |
|---|---|---|
| The short unscoped name | Longer imports and CLI commands | Most people copy them from the docs |
| ADRs that match the code | ADRs 0001–0011 still say `usherjs` | This ADR maps every old name to the new one |
