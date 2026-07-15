import "./env.js";
import { z } from "zod";

/**
 * Strict boolean-from-env parser. CRITICAL: `z.coerce.boolean()` is `Boolean(v)`,
 * so ANY non-empty string — including "false", "0", "no", "off" — coerces to
 * `true`. That turned `OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=false` into "SSRF guard
 * OFF". This parser treats only explicit truthy tokens as true; everything else
 * (incl. "false"/"0"/"no"/"off"/unset) is false.
 */
const envBool = (defaultValue = false) =>
  z
    .preprocess((v) => {
      if (typeof v === "boolean") return v;
      if (typeof v !== "string") return defaultValue;
      const s = v.trim().toLowerCase();
      if (s === "") return defaultValue;
      if (["1", "true", "yes", "on"].includes(s)) return true;
      if (["0", "false", "no", "off"].includes(s)) return false;
      return defaultValue;
    }, z.boolean())
    .default(defaultValue);

const configSchema = z.object({
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().positive().default(8787),
  userAgent: z.string().default("OctorynScout/0.1 (+https://octoryn.com)"),
  dataDir: z.string().default(".octoryn-scout"),
  cacheTtlSeconds: z.coerce.number().int().nonnegative().default(900),
  defaultTimeoutMs: z.coerce.number().int().positive().default(20_000),
  domainRateLimitMs: z.coerce.number().int().nonnegative().default(1_000),
  redisUrl: z.string().optional(),
  databaseUrl: z.string().optional(),
  storageBackend: z.enum(["auto", "sqlite", "file"]).default("auto"),
  browserMaxPages: z.coerce.number().int().positive().default(4),
  browserIdleMs: z.coerce.number().int().nonnegative().default(30_000),
  crawlMaxDepth: z.coerce.number().int().nonnegative().default(2),
  crawlMaxPages: z.coerce.number().int().positive().default(50),
  crawlConcurrency: z.coerce.number().int().positive().default(3),
  chunkMaxTokens: z.coerce.number().int().positive().default(800),
  chunkOverlapTokens: z.coerce.number().int().nonnegative().default(100),
  approvalMode: z.enum(["off", "flag", "enforce"]).default("flag"),
  // "lexical" (default) = built-in offline, deterministic keyword-overlap
  // embedder. "stub" is a deprecated alias kept for backward compatibility and
  // normalized to "lexical". "voyage"/"openai"/"ollama" are real semantic providers.
  embeddingProvider: z
    .enum(["lexical", "stub", "voyage", "openai", "ollama"])
    .default("lexical")
    .transform((v) => (v === "stub" ? "lexical" : v)),
  embeddingModel: z.string().optional(),
  ollamaUrl: z.string().default("http://127.0.0.1:11434"),
  voyageApiKey: z.string().optional(),
  openaiApiKey: z.string().optional(),
  policyFile: z.string().optional(),
  authMode: z.enum(["off", "write", "all"]).default("off"),
  apiKeys: z.string().optional(),
  maxContentBytes: z.coerce.number().int().positive().default(10_485_760),
  allowedContentTypes: z.string().default("html,pdf,xml,text,json"),
  allowPrivateHosts: envBool(false),
  hostAllowlist: z.string().optional(),
  hostBlocklist: z.string().optional(),
  crawlCheckpointEvery: z.coerce.number().int().positive().default(10),
  snapshotRetentionVersions: z.coerce.number().int().nonnegative().default(0),
  snapshotRetentionDays: z.coerce.number().int().nonnegative().default(0),
  auditRetentionDays: z.coerce.number().int().nonnegative().default(0),
  webhookUrls: z.string().optional(),
  webhookSecret: z.string().optional(),
  webhookEvents: z.string().default("*"),
  webhookTimeoutMs: z.coerce.number().int().positive().default(5_000),
  webhookMaxAttempts: z.coerce.number().int().positive().default(3),
  scheduleEnabled: envBool(false),
  refreshIntervalMs: z.coerce.number().int().positive().default(3_600_000),
  stalenessMaxAgeDays: z.coerce.number().int().positive().default(7),
  refreshLimit: z.coerce.number().int().positive().default(50),
  vectorDim: z.coerce.number().int().positive().optional(),
  sqliteVecExtension: z.string().optional(),
  schedulerLockTtlMs: z.coerce.number().int().positive().default(300_000),
  retrievalMode: z.enum(["vector", "lexical", "hybrid"]).default("hybrid"),
  rerankProvider: z.enum(["none", "heuristic", "cohere", "voyage"]).default("heuristic"),
  rerankModel: z.string().optional(),
  cohereApiKey: z.string().optional(),
  extractionProvider: z.enum(["none", "anthropic", "openai", "bedrock"]).default("none"),
  extractionModel: z.string().optional(),
  anthropicApiKey: z.string().optional(),
  bedrockRegion: z.string().default("us-east-1"),
  bedrockBearerToken: z.string().optional(),
  extraHeaders: z.string().optional(),
  stealth: envBool(false),
  mapMaxUrls: z.coerce.number().int().positive().default(5000),
  fetchProvider: z.enum(["local"]).default("local"),
  proxyUrls: z.string().optional(),
  challengeMaxWaitMs: z.coerce.number().int().nonnegative().default(15_000),
  captchaProvider: z.string().default("none"),
  captchaApiKey: z.string().optional()
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(env = process.env): AppConfig {
  return configSchema.parse({
    host: env.OCTORYN_SCOUT_HOST,
    port: env.OCTORYN_SCOUT_PORT,
    userAgent: env.OCTORYN_SCOUT_USER_AGENT,
    dataDir: env.OCTORYN_SCOUT_DATA_DIR,
    cacheTtlSeconds: env.OCTORYN_SCOUT_CACHE_TTL_SECONDS,
    defaultTimeoutMs: env.OCTORYN_SCOUT_DEFAULT_TIMEOUT_MS,
    domainRateLimitMs: env.OCTORYN_SCOUT_DOMAIN_RATE_LIMIT_MS,
    redisUrl: env.REDIS_URL,
    databaseUrl: env.DATABASE_URL,
    storageBackend: env.OCTORYN_SCOUT_STORAGE_BACKEND,
    browserMaxPages: env.OCTORYN_SCOUT_BROWSER_MAX_PAGES,
    browserIdleMs: env.OCTORYN_SCOUT_BROWSER_IDLE_MS,
    crawlMaxDepth: env.OCTORYN_SCOUT_CRAWL_MAX_DEPTH,
    crawlMaxPages: env.OCTORYN_SCOUT_CRAWL_MAX_PAGES,
    crawlConcurrency: env.OCTORYN_SCOUT_CRAWL_CONCURRENCY,
    chunkMaxTokens: env.OCTORYN_SCOUT_CHUNK_MAX_TOKENS,
    chunkOverlapTokens: env.OCTORYN_SCOUT_CHUNK_OVERLAP_TOKENS,
    approvalMode: env.OCTORYN_SCOUT_APPROVAL_MODE,
    embeddingProvider: env.OCTORYN_SCOUT_EMBEDDING_PROVIDER,
    embeddingModel: env.OCTORYN_SCOUT_EMBEDDING_MODEL,
    ollamaUrl: env.OCTORYN_SCOUT_OLLAMA_URL ?? env.OLLAMA_HOST,
    voyageApiKey: env.VOYAGE_API_KEY,
    openaiApiKey: env.OPENAI_API_KEY,
    policyFile: env.OCTORYN_SCOUT_POLICY_FILE,
    authMode: env.OCTORYN_SCOUT_AUTH_MODE,
    apiKeys: env.OCTORYN_SCOUT_API_KEYS,
    maxContentBytes: env.OCTORYN_SCOUT_MAX_CONTENT_BYTES,
    allowedContentTypes: env.OCTORYN_SCOUT_ALLOWED_CONTENT_TYPES,
    allowPrivateHosts: env.OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS,
    hostAllowlist: env.OCTORYN_SCOUT_HOST_ALLOWLIST,
    hostBlocklist: env.OCTORYN_SCOUT_HOST_BLOCKLIST,
    crawlCheckpointEvery: env.OCTORYN_SCOUT_CRAWL_CHECKPOINT_EVERY,
    snapshotRetentionVersions: env.OCTORYN_SCOUT_SNAPSHOT_RETENTION_VERSIONS,
    snapshotRetentionDays: env.OCTORYN_SCOUT_SNAPSHOT_RETENTION_DAYS,
    auditRetentionDays: env.OCTORYN_SCOUT_AUDIT_RETENTION_DAYS,
    webhookUrls: env.OCTORYN_SCOUT_WEBHOOK_URLS,
    webhookSecret: env.OCTORYN_SCOUT_WEBHOOK_SECRET,
    webhookEvents: env.OCTORYN_SCOUT_WEBHOOK_EVENTS,
    webhookTimeoutMs: env.OCTORYN_SCOUT_WEBHOOK_TIMEOUT_MS,
    webhookMaxAttempts: env.OCTORYN_SCOUT_WEBHOOK_MAX_ATTEMPTS,
    scheduleEnabled: env.OCTORYN_SCOUT_SCHEDULE_ENABLED,
    refreshIntervalMs: env.OCTORYN_SCOUT_REFRESH_INTERVAL_MS,
    stalenessMaxAgeDays: env.OCTORYN_SCOUT_STALENESS_MAX_AGE_DAYS,
    refreshLimit: env.OCTORYN_SCOUT_REFRESH_LIMIT,
    vectorDim: env.OCTORYN_SCOUT_VECTOR_DIM,
    sqliteVecExtension: env.OCTORYN_SCOUT_SQLITE_VEC_EXTENSION,
    schedulerLockTtlMs: env.OCTORYN_SCOUT_SCHEDULER_LOCK_TTL_MS,
    retrievalMode: env.OCTORYN_SCOUT_RETRIEVAL_MODE,
    rerankProvider: env.OCTORYN_SCOUT_RERANK_PROVIDER,
    rerankModel: env.OCTORYN_SCOUT_RERANK_MODEL,
    cohereApiKey: env.COHERE_API_KEY,
    extractionProvider: env.OCTORYN_SCOUT_EXTRACTION_PROVIDER,
    extractionModel: env.OCTORYN_SCOUT_EXTRACTION_MODEL,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    bedrockRegion: env.OCTORYN_SCOUT_BEDROCK_REGION,
    bedrockBearerToken: env.AWS_BEARER_TOKEN_BEDROCK,
    extraHeaders: env.OCTORYN_SCOUT_EXTRA_HEADERS,
    stealth: env.OCTORYN_SCOUT_STEALTH,
    mapMaxUrls: env.OCTORYN_SCOUT_MAP_MAX_URLS,
    fetchProvider: env.OCTORYN_SCOUT_FETCH_PROVIDER,
    proxyUrls: env.OCTORYN_SCOUT_PROXY_URLS,
    challengeMaxWaitMs: env.OCTORYN_SCOUT_CHALLENGE_MAX_WAIT_MS,
    captchaProvider: env.OCTORYN_SCOUT_CAPTCHA_PROVIDER,
    captchaApiKey: env.OCTORYN_SCOUT_CAPTCHA_API_KEY
  });
}
