# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Report privately via GitHub Security Advisories ("Report a vulnerability" on the
repository's Security tab) or email **security@octoryn.com**. Include a
description, reproduction steps, and impact. We aim to acknowledge within a few
business days.

## Scope notes

Octopus Scout fetches and renders arbitrary URLs, so a few areas are
security-relevant by design:

- **SSRF protection** — outbound fetch/render is gated by a URL guard that
  rejects non-`http(s)` schemes and hosts resolving to private/loopback/
  link-local/metadata addresses, and re-validates every redirect hop (direct,
  proxied, and browser paths). Report any bypass.
- **Content limits** — responses are size-capped and content-type filtered.
- **Auth** — `OCTORYN_SCOUT_AUTH_MODE` + API keys protect mutating and
  governance/admin endpoints. With no keys configured, auth is off (intended for
  trusted local use); do not expose an unauthenticated instance publicly.
- **Operator responsibility** — proxy use and the CAPTCHA solver seam
  (`docs/CAPTCHA.md`) are operator-supplied; you are responsible for using them
  lawfully and within target sites' terms.

## Supported versions

This project is pre-1.0; only the latest version receives fixes.
