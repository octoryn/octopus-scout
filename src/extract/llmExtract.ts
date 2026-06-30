import { randomUUID } from "node:crypto";

import Anthropic from "@anthropic-ai/sdk";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";

import { loadConfig } from "../config.js";
import { scrapeUrl } from "../ingest/pipeline.js";
import type { ExtractionProvider, StoredExtraction, StructuredExtractionResult } from "../types.js";
import { createExtractionStore, schemaHash } from "./extractionStore.js";

/** Cap the document size sent to the model to keep requests bounded. */
const MAX_DOCUMENT_CHARS = 100_000;

const ANTHROPIC_SYSTEM_PROMPT =
  "You extract structured data from a document. Return only data supported by the text; use null for unknown fields.";
const OPENAI_SYSTEM_PROMPT = "You extract structured data; return only JSON.";

/**
 * Pulls the first text block out of an Anthropic message and returns its text.
 * Returns undefined when no text block is present (e.g. only tool-use blocks).
 */
function firstTextBlock(content: Anthropic.Messages.ContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type === "text") return block.text;
  }
  return undefined;
}

/**
 * Coerces a parsed JSON value into the `Record<string, unknown>` shape the
 * result contract expects. Non-object JSON (array, string, number) is wrapped
 * under a `value` key so callers always receive an object.
 */
function asRecord(parsed: unknown): Record<string, unknown> {
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { value: parsed };
}

/**
 * Structured-extraction provider backed by Anthropic's Messages API via the
 * official SDK. Uses structured-output (`output_config` json_schema) to coerce
 * the model into returning schema-shaped JSON, then parses the first text block.
 */
export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly name = "anthropic";
  readonly model: string;

  private readonly client: Anthropic;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({ apiKey });
    this.model = model ?? "claude-opus-4-8";
  }

  async extract(input: {
    markdown: string;
    schema: Record<string, unknown>;
    prompt?: string;
    sourceUrl: string;
  }): Promise<{ data: Record<string, unknown>; usage?: Record<string, number> }> {
    const userContent =
      (input.prompt ? input.prompt + "\n\n" : "") +
      "Extract per the provided schema from this document:\n\n" +
      input.markdown.slice(0, MAX_DOCUMENT_CHARS);

    // `output_config` is a recent API field that the installed SDK's typed
    // params object may not yet expose; build the request as the SDK param type
    // and attach the structured-output config via a cast so we stay on the
    // official SDK (no raw fetch) while still requesting json_schema output.
    const request = {
      model: this.model,
      max_tokens: 4096,
      system: ANTHROPIC_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
      output_config: { format: { type: "json_schema", schema: input.schema } }
    } as unknown as MessageCreateParamsNonStreaming;

    const response = await this.client.messages.create(request);

    const text = firstTextBlock(response.content);
    if (text === undefined) {
      throw new Error("Anthropic extraction returned no text content block");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(`Anthropic extraction returned non-JSON content: ${(err as Error).message}`);
    }

    const usage: Record<string, number> = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens
    };

    return { data: asRecord(parsed), usage };
  }
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: Record<string, number>;
}

/**
 * Structured-extraction provider backed by OpenAI's chat completions API using
 * `response_format: json_schema`. Uses the global `fetch` (the contract pins
 * OpenAI to the REST endpoint, unlike Claude which must use the official SDK).
 */
export class OpenAIExtractionProvider implements ExtractionProvider {
  readonly name = "openai";
  readonly model: string;

  private readonly apiKey: string;
  private static readonly ENDPOINT = "https://api.openai.com/v1/chat/completions";

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey;
    this.model = model ?? "gpt-4o-mini";
  }

  async extract(input: {
    markdown: string;
    schema: Record<string, unknown>;
    prompt?: string;
    sourceUrl: string;
  }): Promise<{ data: Record<string, unknown>; usage?: Record<string, number> }> {
    const userContent =
      (input.prompt ? input.prompt + "\n\n" : "") +
      "Extract per this JSON schema from the document.\n\nDOCUMENT:\n" +
      input.markdown.slice(0, MAX_DOCUMENT_CHARS);

    const response = await fetch(OpenAIExtractionProvider.ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: OPENAI_SYSTEM_PROMPT },
          { role: "user", content: userContent }
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "extraction", schema: input.schema, strict: false }
        }
      }),
      signal: AbortSignal.timeout(60_000)
    });

    if (!response.ok) {
      let body = "";
      try {
        body = await response.text();
      } catch {
        body = "<unreadable response body>";
      }
      throw new Error(`OpenAI extraction request failed: HTTP ${response.status} ${response.statusText} - ${body}`);
    }

    const json = (await response.json()) as OpenAIChatResponse;
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("OpenAI extraction returned empty content");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      throw new Error(`OpenAI extraction returned non-JSON content: ${(err as Error).message}`);
    }

    return { data: asRecord(parsed), usage: json.usage };
  }
}

interface BedrockToolUseBlock {
  type: string;
  name?: string;
  input?: unknown;
}
interface BedrockMessageResponse {
  content?: BedrockToolUseBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Structured-extraction provider backed by Anthropic models on **Amazon
 * Bedrock**. Uses the Bedrock runtime `invoke` endpoint with a Bedrock API key
 * (bearer token, `AWS_BEARER_TOKEN_BEDROCK`) — no AWS SDK dependency, just the
 * global `fetch`, consistent with this project's zero-extra-dependency stance.
 *
 * JSON is coerced via forced tool-use (`tool_choice: {type:"tool"}`) with the
 * caller's JSON Schema as the tool's `input_schema` — the robust cross-version
 * approach on Bedrock. The model id is a Bedrock model or inference-profile id
 * (e.g. `us.anthropic.claude-sonnet-4-6`).
 */
export class BedrockExtractionProvider implements ExtractionProvider {
  readonly name = "bedrock";
  readonly model: string;

  private readonly region: string;
  private readonly bearerToken: string;

  constructor(bearerToken: string, region: string, model?: string) {
    this.bearerToken = bearerToken;
    this.region = region;
    this.model = model ?? "us.anthropic.claude-sonnet-4-6";
  }

  async extract(input: {
    markdown: string;
    schema: Record<string, unknown>;
    prompt?: string;
    sourceUrl: string;
  }): Promise<{ data: Record<string, unknown>; usage?: Record<string, number> }> {
    const userContent =
      (input.prompt ? input.prompt + "\n\n" : "") +
      "Extract per the provided schema from this document:\n\n" +
      input.markdown.slice(0, MAX_DOCUMENT_CHARS);

    const endpoint = `https://bedrock-runtime.${this.region}.amazonaws.com/model/${this.model}/invoke`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.bearerToken}`,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 4096,
        system: ANTHROPIC_SYSTEM_PROMPT,
        tools: [
          { name: "extract", description: "Extract structured data per the schema.", input_schema: input.schema }
        ],
        tool_choice: { type: "tool", name: "extract" },
        messages: [{ role: "user", content: userContent }]
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Bedrock extraction failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const json = (await response.json()) as BedrockMessageResponse;
    const toolUse = (json.content ?? []).find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.input === undefined) {
      throw new Error("Bedrock extraction returned no tool_use block");
    }

    const usage: Record<string, number> = {};
    if (typeof json.usage?.input_tokens === "number") usage.input_tokens = json.usage.input_tokens;
    if (typeof json.usage?.output_tokens === "number") usage.output_tokens = json.usage.output_tokens;

    return { data: asRecord(toolUse.input), usage: Object.keys(usage).length ? usage : undefined };
  }
}

/**
 * Inert fallback provider used when no LLM is configured (no provider selected
 * or no API key present). Its `extract` always throws; callers gate on
 * `name === "none"` before invoking it.
 */
export class NoneExtractionProvider implements ExtractionProvider {
  readonly name = "none";
  readonly model = "none";

  extract(): Promise<{ data: Record<string, unknown>; usage?: Record<string, number> }> {
    return Promise.reject(new Error("no extraction provider configured"));
  }
}

let provider: ExtractionProvider | undefined;

/**
 * Returns the active structured-extraction provider, selected from config:
 *  - "anthropic" + an Anthropic API key -> {@link AnthropicExtractionProvider}
 *  - "openai" + an OpenAI API key        -> {@link OpenAIExtractionProvider}
 *  - "bedrock" + a Bedrock bearer token  -> {@link BedrockExtractionProvider}
 *  - otherwise (incl. missing key)       -> {@link NoneExtractionProvider}
 *
 * Never throws on a missing key: a misconfigured provider degrades to "none".
 */
export function getExtractionProvider(): ExtractionProvider {
  if (!provider) {
    const config = loadConfig();
    if (config.extractionProvider === "anthropic" && config.anthropicApiKey) {
      provider = new AnthropicExtractionProvider(config.anthropicApiKey, config.extractionModel);
    } else if (config.extractionProvider === "openai" && config.openaiApiKey) {
      provider = new OpenAIExtractionProvider(config.openaiApiKey, config.extractionModel);
    } else if (config.extractionProvider === "bedrock" && config.bedrockBearerToken) {
      provider = new BedrockExtractionProvider(config.bedrockBearerToken, config.bedrockRegion, config.extractionModel);
    } else {
      provider = new NoneExtractionProvider();
    }
  }
  return provider;
}

/**
 * Scrapes a URL (reusing the full governance/cache pipeline) and runs the
 * configured LLM extraction provider over the resulting markdown to produce
 * schema-shaped structured data.
 *
 * Degrades gracefully:
 *  - governance "blocked"     -> skipped result, provider "none"
 *  - no provider configured   -> skipped result, provider "none"
 * Otherwise delegates to the provider; provider errors propagate to the caller.
 */
export async function extractFromUrl(input: {
  url: string;
  schema: Record<string, unknown>;
  prompt?: string;
  forceRefresh?: boolean;
}): Promise<StructuredExtractionResult> {
  const result = await scrapeUrl({ url: input.url, forceRefresh: input.forceRefresh });

  const sourceUrl = result.request.url;
  const finalUrl = result.fetch.finalUrl;
  const governanceStatus = result.evidence.governance.status;

  if (governanceStatus === "blocked") {
    return {
      sourceUrl,
      finalUrl,
      provider: "none",
      data: {},
      governanceStatus: "blocked",
      skipped: true,
      reason: "blocked by governance"
    };
  }

  const activeProvider = getExtractionProvider();
  if (activeProvider.name === "none") {
    return {
      sourceUrl,
      finalUrl,
      provider: "none",
      data: {},
      governanceStatus,
      skipped: true,
      reason: "no extraction provider configured"
    };
  }

  const { data, usage } = await activeProvider.extract({
    markdown: result.extraction.markdown,
    schema: input.schema,
    prompt: input.prompt,
    sourceUrl
  });

  const extraction: StructuredExtractionResult = {
    sourceUrl,
    finalUrl,
    provider: activeProvider.name,
    model: activeProvider.model,
    data,
    usage,
    governanceStatus
  };

  // Best-effort persistence: a real, non-blocked, non-skipped extraction is
  // stored WITH its governanceStatus (mirroring the vector store's secure-by-
  // default contract). A store failure must never break the extraction return.
  await persistExtraction(extraction, input.schema, result.evidence.contentHash);

  return extraction;
}

/**
 * Persist a successful extraction into the ExtractionStore as a
 * {@link StoredExtraction}. Best-effort: any store error is swallowed so it
 * cannot break the extraction return path.
 */
async function persistExtraction(
  extraction: StructuredExtractionResult,
  schema: Record<string, unknown>,
  contentHash: string | undefined
): Promise<void> {
  try {
    const record: StoredExtraction = {
      ...extraction,
      id: randomUUID(),
      schemaHash: schemaHash(schema),
      contentHash,
      createdAt: new Date().toISOString()
    };
    await createExtractionStore().save(record);
  } catch {
    // best-effort: persistence failures never break extraction
  }
}
