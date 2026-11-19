# Changesets

Every pull request that changes what users get from a package adds a
changeset: `pnpm changeset`, pick the bump, and write one or two sentences
for the changelog, addressed to users.

While Usher is `0.x` (ADR 0010):

- **minor**: any breaking change to the public API (`api/*.api.md` diffs that
  remove or narrow something), stored data, or the security behavior agents
  and customers rely on.
- **patch**: everything else: fixes, additions, docs shipped in the package.

The Release workflow turns pending changesets into a "Version packages" pull
request. Merging it publishes to npm with provenance.
