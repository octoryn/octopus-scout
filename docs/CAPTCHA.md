**English** | [简体中文](CAPTCHA.zh-CN.md)

# CAPTCHA — Integration Standard

> **The engine does not solve CAPTCHAs.** It detects them and exposes a stable
> provider seam so an operator who is _authorized to access a site_ can plug in
> their own solver. Solving is deliberately left out — it's sensitive (terms of
> service, access authorization) and requires an external service or model.

This document is the contract for that seam. If you implement a solver, you are
the operator and you are responsible for using it lawfully and within the target
site's terms. See [Responsible use](#responsible-use).

---

## What the engine provides vs. what you provide

| Engine provides                                                                                                 | You provide (optional)                               |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **Detection** — recognizes reCAPTCHA / hCaptcha / Turnstile widgets and extracts the site key (`detectCaptcha`) | A **solver** that turns a challenge into a token     |
| **Provider registry** — `registerCaptchaSolver(name, factory)`                                                  | The factory + adapter to your solving service        |
| **Selection** — `OCTORYN_SCOUT_CAPTCHA_PROVIDER` picks the active solver                                        | An API key via `OCTORYN_SCOUT_CAPTCHA_API_KEY` (BYO) |
| **Default** — `NoopCaptchaSolver` (declines everything)                                                         | —                                                    |
| **Template** — inert `ExternalSolverTemplate` showing the shape                                                 | —                                                    |

The engine ships **no working solver** and makes **no network calls** to any
solving service.

---

## The contract (`src/types.ts`)

```ts
type CaptchaKind = "recaptcha-v2" | "recaptcha-v3" | "hcaptcha" | "turnstile" | "unknown" | (string & {});

interface CaptchaChallenge {
  kind: CaptchaKind;
  url: string; // page URL where the challenge appears
  siteKey?: string; // extracted from the page
  action?: string; // reCAPTCHA v3 action, if any
  data?: Record<string, unknown>; // provider-specific extras
}

interface CaptchaSolution {
  token: string; // the token to inject back into the page/request
  provider: string;
  solvedAt: string; // ISO timestamp
}

interface CaptchaSolver {
  readonly name: string;
  solve(challenge: CaptchaChallenge): Promise<CaptchaSolution | null>;
}
```

**Semantics**

- `solve` returns a `CaptchaSolution` on success, or **`null` to decline** (the
  engine proceeds on its non-solving path — e.g. waiting out a JS challenge or
  returning what it has).
- `solve` **must not throw** for an unsupported or failed challenge — return
  `null`. Throwing is reserved for programmer error.
- Solvers should respect a timeout and never block the fetch path indefinitely.

---

## Implementing a solver

```ts
import { ExternalSolverTemplate, registerCaptchaSolver } from "octopus-scout/dist/fetcher/captcha.js";
import type { CaptchaChallenge, CaptchaSolution } from "octopus-scout/dist/types.js";

class TwoCaptchaSolver extends ExternalSolverTemplate {
  readonly name = "2captcha";

  async solve(c: CaptchaChallenge): Promise<CaptchaSolution | null> {
    if (!this.apiKey || !c.siteKey) return null;
    // 1. POST { method, googlekey/sitekey: c.siteKey, pageurl: c.url, key: this.apiKey }
    //    to your solving service.
    // 2. Poll for the result token (respect a timeout).
    // 3. On success: return { token, provider: this.name, solvedAt: new Date().toISOString() }.
    // 4. On failure/timeout: return null.
    return null; // <-- replace with your implementation
  }
}

registerCaptchaSolver("2captcha", () => new TwoCaptchaSolver());
```

Then run with:

```bash
OCTORYN_SCOUT_CAPTCHA_PROVIDER=2captcha OCTORYN_SCOUT_CAPTCHA_API_KEY=... npm start
```

`getCaptchaSolver()` resolves `2captcha` from the registry; an unregistered or
`none` provider falls back to the no-op solver.

---

## Where it plugs into the pipeline

```
render → navigate → detect interstitial
        ├─ JS challenge (Cloudflare "Just a moment")  → waitForChallenge() [engine handles]
        └─ CAPTCHA widget present (detectCaptcha)      → getCaptchaSolver().solve(challenge)
                                                          ├─ solution → inject token, continue   [operator's solver]
                                                          └─ null     → proceed without solving   [default]
```

`detectCaptcha(html, url)` builds the `CaptchaChallenge`. With the default
no-op solver this branch is inert (always `null`), so the engine behaves exactly
as if CAPTCHA support were absent until you register a solver.

---

## Configuration

| Env var                          | Meaning                                  |
| -------------------------------- | ---------------------------------------- |
| `OCTORYN_SCOUT_CAPTCHA_PROVIDER` | Registered solver name (default `none`)  |
| `OCTORYN_SCOUT_CAPTCHA_API_KEY`  | BYO key passed to your solver (optional) |

---

## Responsible use

Bypassing a CAPTCHA can violate a site's terms of service and, depending on
jurisdiction and context, the law. By registering a solver **you** become the
operator and assume responsibility. Only do so for sites you are authorized to
access (your own properties, contractual data feeds, explicit permission). This
project ships the seam, not the capability, precisely so that this choice — and
its accountability — stays with the operator. The engine's governance layer
(audit trail, per-domain policy, robots.txt respect) applies regardless.
