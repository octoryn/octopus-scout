import { describe, it, expect, afterEach, vi } from "vitest";
import { BedrockExtractionProvider } from "../src/extract/llmExtract.js";

/**
 * Hermetic tests for the Bedrock extraction provider: the request shape (forced
 * tool-use against the bedrock-runtime invoke endpoint with a bearer token) and
 * the response parsing, with `fetch` stubbed. A separate skip-gated live test
 * (tests/bedrockExtractLive.test.ts) exercises the real endpoint when a key is set.
 */
describe("BedrockExtractionProvider", () => {
  afterEach(() => vi.restoreAllMocks());

  it("posts a forced tool-use request to the regional bedrock-runtime endpoint with a bearer token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          content: [{ type: "tool_use", name: "extract", input: { title: "T" } }],
          usage: { input_tokens: 5, output_tokens: 3 }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    });

    const provider = new BedrockExtractionProvider("test-token", "us-east-1", "us.anthropic.claude-sonnet-4-6");
    const out = await provider.extract({
      markdown: "hello world",
      schema: { type: "object" },
      sourceUrl: "https://x.test"
    });

    expect(out.data).toEqual({ title: "T" });
    expect(out.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://bedrock-runtime.us-east-1.amazonaws.com/model/us.anthropic.claude-sonnet-4-6/invoke"
    );
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.anthropic_version).toBe("bedrock-2023-05-31");
    expect(body.tool_choice).toEqual({ type: "tool", name: "extract" });
    expect(body.tools[0].input_schema).toEqual({ type: "object" });
  });

  it("throws a descriptive error on a non-2xx response", async () => {
    vi.stubGlobal("fetch", async () => new Response("denied", { status: 403 }));
    const provider = new BedrockExtractionProvider("t", "us-east-1");
    await expect(provider.extract({ markdown: "x", schema: {}, sourceUrl: "https://x.test" })).rejects.toThrow(
      /Bedrock extraction failed \(403\)/
    );
  });

  it("defaults the model to a sonnet inference profile when none is given", () => {
    expect(new BedrockExtractionProvider("t", "us-east-1").model).toBe("us.anthropic.claude-sonnet-4-6");
  });
});
