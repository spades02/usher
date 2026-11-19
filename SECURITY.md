# Security policy

Usher sits between a business's customers and third-party AI agents, so
security reports get priority over everything else.

## Reporting a vulnerability

Please **don't open a public issue**. Use GitHub's private vulnerability
reporting instead: the repository's **Security** tab → **Report a
vulnerability**. Include the version, a description, and a minimal
reproduction if you have one.

You can expect an acknowledgement within 3 working days, and a fix or a
mitigation plan within 14 days for high-severity issues. We'll credit you in
the advisory unless you'd rather we didn't.

## Supported versions

While Usher is `0.x`, only the latest minor release gets security fixes.

## What's in scope

Anything that lets an agent or a third party do more than the customer
allowed. For example:

- bypassing consent, scopes, step-up or approvals;
- token or code replay;
- reading or changing another customer's grants;
- CSRF or clickjacking on Usher's pages and APIs;
- XSS in the consent pages or the custom elements;
- leaking tool inputs or internal errors to agents;
- forging webhook signatures.

The design notes in [`docs/adr/`](docs/adr/) describe the intended
guarantees.
