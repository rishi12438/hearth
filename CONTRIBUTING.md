# Contributing to Hearth

Thanks for helping out. Here's how to get a change in.

## Before you start

- **Bugs:** open an issue with steps to reproduce, what you expected and what happened. Include your OS, Bun version and storage backend.
- **Features:** open an issue first for anything bigger than a small fix, so we can agree on the approach before you write code.
- **Security issues:** don't open a public issue. Report them privately through [GitHub Security Advisories](https://github.com/rishi12438/hearth/security/advisories/new). See [SECURITY.md](SECURITY.md).

## Setup

```bash
bun install
bun run dev        # demo brain, no keys needed
```

## Making a change

1. Fork the repo and create a branch from `main`.
2. Keep the change focused. One pull request per fix or feature.
3. Match the surrounding code: plain TypeScript, no front-end framework, no build step for `web/`.
4. Add or update tests in `test/` for behaviour you change.
5. Make sure these pass:
   ```bash
   bun test
   bun run typecheck
   ```
6. Open a pull request that explains what changed and why.

## Ground rules worth keeping

These are deliberate design choices. Please don't loosen them without discussing it in an issue first:

- The hub enforces approvals, not the model. Anything with outside effects stops at an Approve card.
- Scripts the assistant writes don't run until a person approves the exact code (hash-pinned).
- Mini apps and artifacts run sandboxed, with no network and no access to the hub.
- No `innerHTML`, and the CSP stays strict.
- The hub stores no model API keys.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
