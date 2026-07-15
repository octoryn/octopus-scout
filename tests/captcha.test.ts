import { afterEach, describe, it, expect } from "vitest";
import {
  clearCaptchaSolvers,
  getCaptchaSolver,
  NoopCaptchaSolver,
  CAPTCHA_TODO,
  registerCaptchaSolver
} from "../src/fetcher/captcha.js";

describe("captcha solver placeholder", () => {
  afterEach(() => {
    clearCaptchaSolvers();
    delete process.env.OCTORYN_SCOUT_CAPTCHA_PROVIDER;
  });

  it("exposes CAPTCHA_TODO sentinel as true", () => {
    expect(CAPTCHA_TODO).toBe(true);
  });

  it("getCaptchaSolver() returns a NoopCaptchaSolver named 'none'", () => {
    const solver = getCaptchaSolver();
    expect(solver).toBeInstanceOf(NoopCaptchaSolver);
    expect(solver.name).toBe("none");
  });

  it("solve() resolves to null for a recaptcha input", async () => {
    const solver = getCaptchaSolver();
    const result = await solver.solve({ kind: "recaptcha", url: "https://x" });
    expect(result).toBeNull();
  });

  it("NoopCaptchaSolver instance declines directly", async () => {
    const solver = new NoopCaptchaSolver();
    expect(solver.name).toBe("none");
    await expect(solver.solve({ kind: "recaptcha", url: "https://x" })).resolves.toBeNull();
  });

  it("selects a registered mock solver by provider name", async () => {
    process.env.OCTORYN_SCOUT_CAPTCHA_PROVIDER = "mock";
    registerCaptchaSolver("mock", () => ({
      name: "mock",
      async solve(challenge) {
        return { provider: "mock", token: `token-for-${challenge.kind}`, solvedAt: "2026-07-15T00:00:00.000Z" };
      }
    }));

    const solver = getCaptchaSolver();
    await expect(solver.solve({ kind: "hcaptcha", url: "https://x" })).resolves.toMatchObject({
      provider: "mock",
      token: "token-for-hcaptcha"
    });
  });

  it("falls back to noop when a registered factory throws", () => {
    process.env.OCTORYN_SCOUT_CAPTCHA_PROVIDER = "broken";
    registerCaptchaSolver("broken", () => {
      throw new Error("boom");
    });
    expect(getCaptchaSolver()).toBeInstanceOf(NoopCaptchaSolver);
  });
});
