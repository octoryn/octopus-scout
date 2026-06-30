import { z } from "zod";

export const scrapeActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wait"), ms: z.number().int().positive().max(30_000) }),
  z.object({
    type: z.literal("waitForSelector"),
    selector: z.string(),
    timeoutMs: z.number().int().positive().optional()
  }),
  z.object({ type: z.literal("click"), selector: z.string() }),
  z.object({
    type: z.literal("scroll"),
    direction: z.enum(["down", "up"]).optional(),
    amount: z.number().int().optional()
  }),
  z.object({ type: z.literal("type"), selector: z.string(), text: z.string() }),
  z.object({ type: z.literal("press"), key: z.string() }),
  z.object({ type: z.literal("screenshot") })
]);

export const scrapeRequestSchema = z.object({
  url: z.string().url(),
  render: z.enum(["auto", "static", "browser"]).default("auto"),
  waitForSelector: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  respectRobots: z.boolean().default(true),
  forceRefresh: z.boolean().default(false),
  includeHtml: z.boolean().default(false),
  includeScreenshot: z.boolean().default(false),
  tags: z.array(z.string()).optional(),
  actions: z.array(scrapeActionSchema).max(50).optional()
});

export const mapRequestSchema = z.object({
  url: z.string().url(),
  limit: z.number().int().positive().max(5000).optional(),
  search: z.string().optional(),
  includeSubdomains: z.boolean().default(false),
  useSitemap: z.boolean().default(true),
  includePaths: z.array(z.string()).optional(),
  excludePaths: z.array(z.string()).optional()
});

export const fetchRequestSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().optional(),
  respectRobots: z.boolean().default(true)
});

export const sitemapRequestSchema = z.object({
  url: z.string().url(),
  timeoutMs: z.number().int().positive().optional(),
  recursive: z.boolean().default(false),
  maxSitemaps: z.number().int().positive().max(50).default(5)
});

export const crawlRequestSchema = z.object({
  url: z.string().url(),
  maxDepth: z.number().int().nonnegative().max(10).optional(),
  maxPages: z.number().int().positive().max(2000).optional(),
  sameOriginOnly: z.boolean().default(true),
  includeSubdomains: z.boolean().default(false),
  render: z.enum(["auto", "static", "browser"]).default("auto"),
  respectRobots: z.boolean().default(true),
  useSitemap: z.boolean().default(true),
  includePatterns: z.array(z.string()).optional(),
  excludePatterns: z.array(z.string()).optional(),
  concurrency: z.number().int().positive().max(16).optional(),
  resumeCrawlId: z.string().optional()
});

export const siteIngestRequestSchema = crawlRequestSchema.extend({
  maxTokens: z.number().int().positive().max(4000).optional(),
  overlapTokens: z.number().int().nonnegative().max(1000).optional()
});

export const retentionRequestSchema = z.object({
  snapshotRetentionVersions: z.number().int().nonnegative().optional(),
  snapshotRetentionDays: z.number().int().nonnegative().optional(),
  auditRetentionDays: z.number().int().nonnegative().optional()
});

export const refreshRequestSchema = z.object({
  maxAgeDays: z.number().int().positive().optional(),
  limit: z.number().int().positive().max(500).optional()
});

export const exportRequestSchema = z.object({
  url: z.string().url(),
  maxTokens: z.number().int().positive().max(4000).optional(),
  overlapTokens: z.number().int().nonnegative().max(1000).optional(),
  embed: z.boolean().default(false),
  forceRefresh: z.boolean().default(false)
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  decidedBy: z.string().min(1),
  note: z.string().optional()
});

export const approvalListQuerySchema = z.object({
  status: z.enum(["pending", "approved", "rejected"]).optional(),
  limit: z.coerce.number().int().positive().max(500).default(100)
});

export const auditListQuerySchema = z.object({
  target: z.string().optional(),
  action: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(200)
});

export const ingestRequestSchema = z.object({
  url: z.string().url(),
  maxTokens: z.number().int().positive().max(4000).optional(),
  overlapTokens: z.number().int().nonnegative().max(1000).optional(),
  forceRefresh: z.boolean().default(false)
});

export const searchRequestSchema = z.object({
  query: z.string().min(1),
  topK: z.number().int().positive().max(50).default(5),
  url: z.string().url().optional(),
  minTrust: z.number().min(0).max(1).optional(),
  includeBlocked: z.boolean().default(false),
  includeUnapproved: z.boolean().default(false),
  mode: z.enum(["vector", "lexical", "hybrid"]).optional(),
  rerank: z.boolean().optional(),
  rewrite: z.boolean().default(false)
});

export const structuredExtractRequestSchema = z.object({
  url: z.string().url(),
  schema: z.record(z.string(), z.any()),
  prompt: z.string().optional(),
  forceRefresh: z.boolean().default(false)
});

export const batchExtractRequestSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(100),
  schema: z.record(z.string(), z.any()),
  prompt: z.string().optional(),
  forceRefresh: z.boolean().default(false)
});

export const siteExtractRequestSchema = z.object({
  url: z.string().url(),
  schema: z.record(z.string(), z.any()),
  prompt: z.string().optional(),
  forceRefresh: z.boolean().default(false),
  maxPages: z.number().int().positive().max(2000).default(25),
  maxDepth: z.number().int().nonnegative().max(10).default(1),
  includeSubdomains: z.boolean().default(false),
  search: z.string().optional()
});
