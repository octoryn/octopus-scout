/**
 * Public library entry point for octopus-scout.
 *
 * Consumers can `import { scrapeUrl, crawl, mapSite, ingestUrl, searchKnowledge,
 * extractFromUrl, buildServer } from "octopus-scout"`. The CLI (`octopus-scout`)
 * and MCP server (`octopus-scout-mcp`) are separate bin entry points.
 */

// Types
export type * from "./types.js";

// Configuration
export { loadConfig } from "./config.js";
export type { AppConfig } from "./config.js";

// Core ingestion pipeline
export { scrapeUrl } from "./ingest/pipeline.js";

// Crawl + discovery
export { crawl } from "./crawl/crawler.js";
export { mapSite } from "./crawl/siteMap.js";
export { readSitemap } from "./sitemap.js";

// Knowledge: ingest, search, export, chunking, embeddings
export { ingestUrl, searchKnowledge } from "./knowledge/retrieval.js";
export { ingestSite } from "./knowledge/siteIngest.js";
export { buildRagDocument, toJsonl } from "./knowledge/ragExport.js";
export { getVectorStore } from "./knowledge/vectorStore.js";
export { getEmbeddingProvider } from "./knowledge/embedding.js";
export { getReranker } from "./knowledge/reranker.js";

// Structured extraction
export { extractFromUrl, getExtractionProvider } from "./extract/llmExtract.js";

// Governance
export { getAuditLog } from "./governance/auditLog.js";
export { getApprovalStore } from "./governance/approvalStore.js";

// Anti-bot seams
export { getFetchProvider } from "./fetcher/fetchProvider.js";
export { getCaptchaSolver, registerCaptchaSolver, detectCaptcha } from "./fetcher/captcha.js";

// HTTP server
export { buildServer } from "./server.js";
