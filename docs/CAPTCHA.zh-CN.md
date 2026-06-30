[English](CAPTCHA.md) | **简体中文**

# CAPTCHA — 集成标准

> **本引擎不破解 CAPTCHA。** 它只负责检测 CAPTCHA，并暴露一个稳定的
> 提供方接缝 (provider seam)，让*已获授权访问某站点*的运营方
> 接入自己的破解器 (solver)。破解功能是被刻意排除在外的——它涉及敏感问题
> （服务条款、访问授权），并且需要外部服务或模型。

本文档即是该接缝的契约。如果你实现了破解器，那么你就是运营方，并须
为合法使用它、并遵守目标站点的条款负责。参见 [负责任使用](#负责任使用)。

---

## 引擎提供什么 vs. 你提供什么

| 引擎提供                                                                                         | 你提供（可选）                                                    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **检测**——识别 reCAPTCHA / hCaptcha / Turnstile 控件并提取站点密钥 (site key)（`detectCaptcha`） | 一个把挑战 (challenge) 转换为令牌 (token) 的**破解器**            |
| **提供方注册表**——`registerCaptchaSolver(name, factory)`                                         | 对接你的破解服务的工厂 (factory) 与适配器 (adapter)               |
| **选择**——`OCTORYN_SCOUT_CAPTCHA_PROVIDER` 选定当前生效的破解器                                  | 通过 `OCTORYN_SCOUT_CAPTCHA_API_KEY` 提供的 API 密钥（自备，BYO） |
| **默认值**——`NoopCaptchaSolver`（一律拒绝）                                                      | —                                                                 |
| **模板**——惰性的 `ExternalSolverTemplate`，用于展示其结构                                        | —                                                                 |

引擎**不附带任何可用的破解器**，也**不会向任何破解服务发起网络调用**。

---

## 契约（`src/types.ts`）

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

**语义**

- `solve` 在成功时返回 `CaptchaSolution`，或返回 **`null` 以表示拒绝**（引擎
  会继续沿其非破解路径推进——例如等待 JS 挑战自行通过，或返回已有的内容）。
- 对于不支持或失败的挑战，`solve` **不得抛出异常**——应返回
  `null`。抛出异常仅保留给编程错误使用。
- 破解器应遵守超时设置，绝不无限期阻塞抓取 (fetch) 路径。

---

## 实现一个破解器

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

然后这样运行：

```bash
OCTORYN_SCOUT_CAPTCHA_PROVIDER=2captcha OCTORYN_SCOUT_CAPTCHA_API_KEY=... npm start
```

`getCaptchaSolver()` 会从注册表中解析出 `2captcha`；未注册的或值为
`none` 的提供方会回退到 no-op 破解器。

---

## 它在流水线中的接入位置

```
render → navigate → detect interstitial
        ├─ JS challenge (Cloudflare "Just a moment")  → waitForChallenge() [engine handles]
        └─ CAPTCHA widget present (detectCaptcha)      → getCaptchaSolver().solve(challenge)
                                                          ├─ solution → inject token, continue   [operator's solver]
                                                          └─ null     → proceed without solving   [default]
```

`detectCaptcha(html, url)` 负责构建 `CaptchaChallenge`。在使用默认的
no-op 破解器时，该分支是惰性的（始终为 `null`），因此在你注册破解器之前，
引擎的行为与完全没有 CAPTCHA 支持时完全一致。

---

## 配置

| 环境变量                         | 含义                                    |
| -------------------------------- | --------------------------------------- |
| `OCTORYN_SCOUT_CAPTCHA_PROVIDER` | 已注册的破解器名称（默认 `none`）       |
| `OCTORYN_SCOUT_CAPTCHA_API_KEY`  | 传给你的破解器的自备 (BYO) 密钥（可选） |

---

## 负责任使用

绕过 CAPTCHA 可能违反站点的服务条款，并且视司法管辖区与具体情境而定，
也可能违反法律。一旦注册破解器，**你**便成为运营方并承担相应责任。请仅
对你有权访问的站点这样做（你自己的资产、合同约定的数据源、明确的授权）。
本项目交付的是这一接缝，而非这项能力，正是为了让这一选择——以及与之相伴的
问责——留在运营方手中。引擎的治理 (governance) 层（审计轨迹、按域名的策略、
对 robots.txt 的遵守）在任何情况下都依然适用。
