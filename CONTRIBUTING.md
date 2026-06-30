# Contributing to Octopus Scout

Thanks for your interest in contributing. This guide covers the basics.

## Development setup

```bash
npm install
npm run playwright:install   # for browser-render features
npm run dev                  # http://localhost:8787
```

Requires Node ≥ 22.

## Before opening a PR

Run the full local gate — CI runs the same checks:

```bash
npm run typecheck                                   # tsc --noEmit, must be clean
npm run format:check                                # prettier
OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true npm test     # vitest (the flag lets localhost-fixture tests run)
```

- **Type safety:** the project is `strict`. No `any` escapes unless unavoidable and commented.
- **Tests:** new behavior needs tests. Tests must be **hermetic** — localhost only (no external network), unique temp dirs, cleaned up. Tests that need an API key / real DB must be gated with `describe.skipIf(...)` so the default suite stays green.
- **Stub embedder is hash-based** — never assert the *sign* of a cosine score in a test; only finiteness/ordering with a real provider.
- **Zero-dependency anti-bot:** the `src/fetcher` anti-bot code (stealth, proxy, challenge, captcha) must not add third-party libraries — Node built-ins + Playwright only.

## Project layout

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map and data flow.

## Commit / PR

- Keep PRs focused. Describe what changed and why.
- Update `CHANGELOG.md` (Unreleased section) for user-facing changes.
- Update the relevant docs (`README.md`, `docs/`) when you change the API/CLI/MCP surface.

## Reporting bugs / security issues

File a normal issue for bugs. For security vulnerabilities, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
