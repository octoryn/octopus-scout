#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { scrapeUrl } from "./ingest/pipeline.js";
import { crawl } from "./crawl/crawler.js";
import { mapSite } from "./crawl/siteMap.js";
import { mapRequestSchema } from "./ingest/schema.js";
import { buildRagDocument } from "./knowledge/ragExport.js";
import { ingestSite } from "./knowledge/siteIngest.js";
import { ingestUrl, searchKnowledge } from "./knowledge/retrieval.js";
import { extractFromUrl } from "./extract/llmExtract.js";
import type { RenderMode, RetrievalMode } from "./types.js";

const server = new Server(
  {
    name: "octopus-scout",
    version: "0.1.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "octoryn_scrape",
      description: "Scrape a URL into governed Markdown/JSON with evidence anchors.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          render: { type: "string", enum: ["auto", "static", "browser"], default: "auto" },
          forceRefresh: { type: "boolean", default: false }
        },
        required: ["url"]
      }
    },
    {
      name: "octoryn_crawl",
      description: "Crawl a site from a root URL, following links depth-bounded, returning a CrawlResult.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          maxDepth: { type: "number" },
          maxPages: { type: "number" }
        },
        required: ["url"]
      }
    },
    {
      name: "octoryn_map",
      description: "Fast site URL discovery from sitemap(s) and root-page links, without scraping each page.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          limit: { type: "number" },
          search: { type: "string" },
          includeSubdomains: { type: "boolean", default: false },
          useSitemap: { type: "boolean", default: true },
          includePaths: { type: "array", items: { type: "string" } },
          excludePaths: { type: "array", items: { type: "string" } }
        },
        required: ["url"]
      }
    },
    {
      name: "octoryn_ingest_site",
      description: "Crawl a whole site from a root URL and index every page into the vector store.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          maxDepth: { type: "number" },
          maxPages: { type: "number" },
          maxTokens: { type: "number" },
          overlapTokens: { type: "number" }
        },
        required: ["url"]
      }
    },
    {
      name: "octoryn_export",
      description: "Scrape a URL and build a chunked RAG document with evidence and optional embeddings.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          embed: { type: "boolean", default: false }
        },
        required: ["url"]
      }
    },
    {
      name: "octoryn_ingest",
      description: "Scrape, chunk, embed, and index a URL into the vector store for retrieval.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          maxTokens: { type: "number" },
          overlapTokens: { type: "number" },
          forceRefresh: { type: "boolean", default: false }
        },
        required: ["url"]
      }
    },
    {
      name: "octoryn_search",
      description:
        "Hybrid search over indexed knowledge (vector, lexical, or fused), reranked, returning the top matching chunks.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          topK: { type: "number", default: 5 },
          url: { type: "string", format: "uri" },
          minTrust: { type: "number" },
          includeBlocked: { type: "boolean", default: false },
          mode: { type: "string", enum: ["vector", "lexical", "hybrid"] },
          rerank: { type: "boolean" }
        },
        required: ["query"]
      }
    },
    {
      name: "octoryn_extract",
      description: "Scrape a URL and extract structured data into a caller-supplied JSON schema via an LLM provider.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", format: "uri" },
          schema: { type: "object" },
          prompt: { type: "string" },
          forceRefresh: { type: "boolean", default: false }
        },
        required: ["url", "schema"]
      }
    }
  ]
}));

function asText(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;

  if (name === "octoryn_scrape") {
    const args = (rawArgs ?? {}) as { url?: string; render?: RenderMode; forceRefresh?: boolean };
    if (!args.url) {
      throw new Error("url is required");
    }
    const result = await scrapeUrl({
      url: args.url,
      render: args.render ?? "auto",
      forceRefresh: args.forceRefresh ?? false
    });
    return asText({
      url: result.fetch.finalUrl,
      title: result.extraction.title,
      markdown: result.extraction.markdown,
      evidence: result.evidence,
      cache: result.cache
    });
  }

  if (name === "octoryn_crawl") {
    const args = (rawArgs ?? {}) as { url?: string; maxDepth?: number; maxPages?: number };
    if (!args.url) {
      throw new Error("url is required");
    }
    const result = await crawl({
      url: args.url,
      maxDepth: args.maxDepth,
      maxPages: args.maxPages
    });
    return asText(result);
  }

  if (name === "octoryn_map") {
    const args = mapRequestSchema.parse(rawArgs ?? {});
    const result = await mapSite(args);
    return asText(result);
  }

  if (name === "octoryn_ingest_site") {
    const args = (rawArgs ?? {}) as {
      url?: string;
      maxDepth?: number;
      maxPages?: number;
      maxTokens?: number;
      overlapTokens?: number;
    };
    if (!args.url) {
      throw new Error("url is required");
    }
    const result = await ingestSite({
      url: args.url,
      maxDepth: args.maxDepth,
      maxPages: args.maxPages,
      maxTokens: args.maxTokens,
      overlapTokens: args.overlapTokens
    });
    return asText(result);
  }

  if (name === "octoryn_export") {
    const args = (rawArgs ?? {}) as { url?: string; embed?: boolean };
    if (!args.url) {
      throw new Error("url is required");
    }
    const result = await scrapeUrl({ url: args.url });
    const doc = await buildRagDocument(result, { embed: args.embed ?? false });
    return asText(doc);
  }

  if (name === "octoryn_ingest") {
    const args = (rawArgs ?? {}) as {
      url?: string;
      maxTokens?: number;
      overlapTokens?: number;
      forceRefresh?: boolean;
    };
    if (!args.url) {
      throw new Error("url is required");
    }
    const result = await ingestUrl({
      url: args.url,
      maxTokens: args.maxTokens,
      overlapTokens: args.overlapTokens,
      forceRefresh: args.forceRefresh ?? false
    });
    return asText(result);
  }

  if (name === "octoryn_search") {
    const args = (rawArgs ?? {}) as {
      query?: string;
      topK?: number;
      url?: string;
      minTrust?: number;
      includeBlocked?: boolean;
      mode?: RetrievalMode;
      rerank?: boolean;
    };
    if (!args.query) {
      throw new Error("query is required");
    }
    const result = await searchKnowledge({
      query: args.query,
      topK: args.topK,
      url: args.url,
      minTrust: args.minTrust,
      includeBlocked: args.includeBlocked ?? false,
      mode: args.mode,
      rerank: args.rerank
    });
    return asText(result);
  }

  if (name === "octoryn_extract") {
    const args = (rawArgs ?? {}) as {
      url?: string;
      schema?: Record<string, unknown>;
      prompt?: string;
      forceRefresh?: boolean;
    };
    if (!args.url) {
      throw new Error("url is required");
    }
    if (!args.schema || typeof args.schema !== "object") {
      throw new Error("schema (object) is required");
    }
    const result = await extractFromUrl({
      url: args.url,
      schema: args.schema,
      prompt: args.prompt,
      forceRefresh: args.forceRefresh ?? false
    });
    return asText(result);
  }

  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
