# ADR 0000 — Record architecture decisions

- **Status:** Accepted
- **Date:** 2026-11-19

## Context

Usher is built phase by phase, and each phase hinges on one architectural choice.
Months from now, contributors (and we) will ask "why did we do it this way?" The
answer must not live only in chat history.

## Decision

Every significant architectural choice gets an Architecture Decision Record (ADR)
in `docs/adr/`, numbered sequentially, using this structure:

1. **Context** — the forces at play.
2. **Options considered** — real alternatives, not strawmen.
3. **Decision** — what we chose.
4. **Why** — the reasoning that tipped it.
5. **Trade-offs** — what we knowingly give up, and how we mitigate it.
6. **Revisit when** — the signals that would make us reconsider.

ADRs are immutable once accepted. To change a decision, write a new ADR that
supersedes the old one and update the old one's status.

## Trade-offs

- Small writing overhead per decision.
- In return: onboarding, reviews, and future reversals are cheaper because the
  original reasoning is preserved.
