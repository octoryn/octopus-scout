import { describe, it, expect } from "vitest";
import { getCaptchaSolver, NoopCaptchaSolver, CAPTCHA_TODO } from "../src/fetcher/captcha.js";

describe("captcha solver placeholder", () => {
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
});
