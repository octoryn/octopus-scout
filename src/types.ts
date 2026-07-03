export type RenderMode = "auto" | "static" | "browser";

export interface ScrapeRequest {
  url: string;
  render?: RenderMode;
  waitForSelector?: string;
  timeoutMs?: number;
  respectRobots?: boolean;
  forceRefresh?: boolean;
  includeHtml?: boolean;
  includeScreenshot?: boolean;
  tags?: string[];
  actions?: ScrapeAction[];
}

export interface FetchRequest {
  url: string;
  timeoutMs?: number;
  respectRobots?: boolean;
}

export interface RenderRequest extends FetchRequest {
  waitForSelector?: string;
  includeScreenshot?: boolean;
  actions?: ScrapeAction[];
}

/**
 * A pre-capture browser interaction (cf. Firecrawl "actions"), executed in order
 * before the rendered DOM is captured. Only available on browser-rendered fetches.
 */
export type ScrapeAction =
  | { type: "wait"; ms: number }
  | { type: "waitForSelector"; selector: string; timeoutMs?: number }
  | { type: "click"; selector: string }
  | { type: "scroll"; direction?: "down" | "up"; amount?: number }
  | { type: "type"; selector: string; text: string }
  | { type: "press"; key: string }
  | { type: "screenshot" };

export interface FetchedResource {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  headers: Record<string, string>;
  body: Buffer;
  fetchedAt: string;
  elapsedMs: number;
}

export interface RenderedResource extends FetchedResource {
  screenshotBase64?: string;
  actionScreenshots?: string[];
}

export interface LinkExtract {
  href: string;
  text?: string;
}

export interface ImageExtract {
  src: string;
  alt?: string;
  caption?: string;
}

export interface TableExtract {
  caption?: string;
  headers: string[];
  rows: string[][];
}

export interface ExtractionResult {
  kind: "html" | "pdf" | "text";
  title?: string;
  byline?: string;
  siteName?: string;
  excerpt?: string;
  language?: string;
  canonicalUrl?: string;
  description?: string;
  textContent: string;
  markdown: string;
  links: LinkExtract[];
  images: ImageExtract[];
  tables: TableExtract[];
  metadata: Record<string, unknown>;
}

export interface CitationAnchor {
  id: string;
  sourceUrl: string;
  textQuote: string;
  markdownOffset: number;
  selector?: string;
}

export interface SourceTrustScore {
  score: number;
  label: "low" | "medium" | "high";
  reasons: string[];
}

export interface GovernanceDecision {
  status: "allowed" | "blocked" | "requires_approval";
  reasons: string[];
  policyVersion: string;
}

export interface EvidenceBundle {
  sourceUrl: string;
  finalUrl: string;
  canonicalUrl?: string;
  capturedAt: string;
  contentHash: string;
  anchors: CitationAnchor[];
  trust: SourceTrustScore;
  governance: GovernanceDecision;
}

export interface ScrapeResult {
  request: Required<
    Pick<ScrapeRequest, "render" | "respectRobots" | "forceRefresh" | "includeHtml" | "includeScreenshot">
  > &
    Omit<ScrapeRequest, "render" | "respectRobots" | "forceRefresh" | "includeHtml" | "includeScreenshot">;
  fetch: {
    url: string;
    finalUrl: string;
    status: number;
    ok: boolean;
    contentType: string;
    fetchedAt: string;
    elapsedMs: number;
    rendered: boolean;
    html?: string;
    screenshotBase64?: string;
    actionScreenshots?: string[];
  };
  extraction: ExtractionResult;
  evidence: EvidenceBundle;
  cache: {
    hit: boolean;
    snapshotId?: string;
    dedup?: {
      duplicate: boolean;
      ofSnapshotId?: string;
    };
  };
}

export interface SnapshotRecord {
  id: string;
  url: string;
  finalUrl: string;
  contentHash: string;
  createdAt: string;
  result: ScrapeResult;
}

export interface SnapshotSummary {
  id: string;
  url: string;
  finalUrl: string;
  contentHash: string;
  createdAt: string;
  title?: string;
  governanceStatus?: GovernanceDecision["status"];
}

export interface SitemapResult {
  sourceUrl: string;
  urls: string[];
  sitemapUrls: string[];
}

// ---------------------------------------------------------------------------
// Crawl (depth-bounded link following)
// ---------------------------------------------------------------------------

export interface CrawlRequest {
  url: string;
  maxDepth?: number;
  maxPages?: number;
  sameOriginOnly?: boolean;
  includeSubdomains?: boolean;
  render?: RenderMode;
  respectRobots?: boolean;
  useSitemap?: boolean;
  includePatterns?: string[];
  excludePatterns?: string[];
  concurrency?: number;
  resumeCrawlId?: string;
}

export interface CrawlPageResult {
  url: string;
  depth: number;
  status: number;
  ok: boolean;
  snapshotId?: string;
  contentHash?: string;
  title?: string;
  duplicate?: boolean;
  error?: string;
}

export interface CrawlResult {
  rootUrl: string;
  startedAt: string;
  finishedAt: string;
  pagesCrawled: number;
  discoveredUrls: number;
  pages: CrawlPageResult[];
}

// ---------------------------------------------------------------------------
// Knowledge pipeline: chunking + RAG export
// ---------------------------------------------------------------------------

export interface Chunk {
  id: string;
  index: number;
  content: string;
  tokens: number;
  headingPath: string[];
  anchorId?: string;
  charStart: number;
  charEnd: number;
}

export interface ChunkingOptions {
  maxTokens?: number;
  overlapTokens?: number;
}

export interface ChunkingResult {
  sourceUrl: string;
  contentHash: string;
  chunkCount: number;
  chunks: Chunk[];
}

export interface EmbeddedChunk extends Chunk {
  embedding?: number[];
}

export interface RagDocument {
  id: string;
  sourceUrl: string;
  finalUrl: string;
  title?: string;
  contentHash: string;
  capturedAt: string;
  trust: SourceTrustScore;
  governance: GovernanceDecision;
  chunks: EmbeddedChunk[];
}

/**
 * Pluggable embedding hook. The default implementation is a deterministic,
 * offline lexical (keyword-overlap) embedder — good enough to make vector search
 * useful out of the box, but NOT semantic. Real semantic providers (Voyage,
 * OpenAI, etc.) implement this same interface and are injected where embeddings
 * are produced.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

// ---------------------------------------------------------------------------
// Governance: audit trail + human approval workflow
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  status: string;
  policyVersion?: string;
  detail?: Record<string, unknown>;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface ApprovalRecord {
  id: string;
  url: string;
  snapshotId?: string;
  contentHash: string;
  status: ApprovalStatus;
  reasons: string[];
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
}

// ---------------------------------------------------------------------------
// Per-domain governance policy
// ---------------------------------------------------------------------------

export type PolicyAction = "allow" | "block" | "require_approval";

export interface DomainPolicy {
  domain: string;
  action?: PolicyAction;
  rateLimitMs?: number;
  trustOverride?: number;
  note?: string;
}

export interface GovernancePolicy {
  version: string;
  defaultAction?: PolicyAction;
  sensitiveKeywords?: string[];
  domains: DomainPolicy[];
}

// ---------------------------------------------------------------------------
// Vector store + retrieval (the RAG read-path)
// ---------------------------------------------------------------------------

export interface StoredChunk {
  chunkId: string;
  documentId: string;
  sourceUrl: string;
  finalUrl: string;
  title?: string;
  contentHash: string;
  index: number;
  content: string;
  headingPath: string[];
  anchorId?: string;
  governanceStatus: GovernanceDecision["status"];
  trustScore: number;
  capturedAt: string;
  embedding: number[];
}

export interface VectorSearchFilter {
  url?: string;
  minTrust?: number;
  /**
   * Re-include governance-blocked chunks (default false). Blocked content is
   * excluded from search by default and only surfaced when this is explicitly
   * set.
   */
  includeBlocked?: boolean;
  /**
   * Re-include `requires_approval` chunks (default false). By default search
   * returns only `allowed` chunks; setting this opts the not-yet-approved
   * chunks back in (but never blocked ones unless {@link includeBlocked}).
   */
  includeUnapproved?: boolean;
}

export interface VectorSearchHit {
  chunkId: string;
  documentId: string;
  score: number;
  sourceUrl: string;
  finalUrl: string;
  title?: string;
  content: string;
  headingPath: string[];
  anchorId?: string;
  contentHash: string;
  governanceStatus: GovernanceDecision["status"];
  trustScore: number;
}

export interface VectorSearchResult {
  query: string;
  topK: number;
  hits: VectorSearchHit[];
}

export interface IngestResult {
  documentId: string;
  sourceUrl: string;
  finalUrl: string;
  contentHash: string;
  chunksIndexed: number;
  governanceStatus: GovernanceDecision["status"];
  skipped?: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Observability: readiness + metrics
// ---------------------------------------------------------------------------

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ReadinessReport {
  ok: boolean;
  checks: ReadinessCheck[];
  checkedAt: string;
}

export interface MetricsSnapshot {
  uptimeSeconds: number;
  counters: Record<string, number>;
  domains: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Crawl job persistence + resumability
// ---------------------------------------------------------------------------

export type CrawlJobStatus = "running" | "paused" | "completed" | "failed";

export interface CrawlFrontierEntry {
  url: string;
  depth: number;
}

export interface CrawlJobState {
  crawlId: string;
  rootUrl: string;
  options: CrawlRequest;
  status: CrawlJobStatus;
  frontier: CrawlFrontierEntry[];
  visited: string[];
  pages: CrawlPageResult[];
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface CrawlJobSummary {
  crawlId: string;
  rootUrl: string;
  status: CrawlJobStatus;
  pagesCrawled: number;
  frontierSize: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

// ---------------------------------------------------------------------------
// Whole-site ingestion (crawl -> index)
// ---------------------------------------------------------------------------

export interface SiteIngestResult {
  crawlId?: string;
  rootUrl: string;
  pagesCrawled: number;
  pagesIndexed: number;
  chunksIndexed: number;
  skipped: number;
  startedAt: string;
  finishedAt: string;
  pages: Array<{
    url: string;
    indexed: boolean;
    chunks: number;
    governanceStatus?: GovernanceDecision["status"];
    reason?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

export interface RetentionReport {
  snapshotsRemoved: number;
  auditEventsRemoved: number;
  approvalsRemoved: number;
  ranAt: string;
}

// ---------------------------------------------------------------------------
// Eventing + webhooks + scheduled refresh
// ---------------------------------------------------------------------------

export type ScoutEventType =
  | "scrape.completed"
  | "approval.requested"
  | "approval.decided"
  | "crawl.completed"
  | "site_ingest.completed"
  | "job.failed";

export interface ScoutEvent {
  id: string;
  type: ScoutEventType;
  at: string;
  target: string;
  data?: Record<string, unknown>;
}

export type WebhookDeliveryStatus = "delivered" | "failed" | "pending";

export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: ScoutEventType;
  url: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  statusCode?: number;
  error?: string;
  at: string;
}

export interface StalenessItem {
  url: string;
  ageSeconds: number;
  refreshed: boolean;
  reason?: string;
}

export interface StalenessSweepResult {
  scanned: number;
  refreshed: number;
  failures: number;
  ranAt: string;
  items: StalenessItem[];
}

// ---------------------------------------------------------------------------
// Persistent queue job introspection
// ---------------------------------------------------------------------------

export interface JobInfo {
  id: string;
  name: string;
  queue: string;
  state: string;
  progress?: number | Record<string, unknown>;
  attemptsMade?: number;
  failedReason?: string;
  returnValue?: unknown;
  data?: unknown;
  timestamp?: number;
  finishedOn?: number;
}

// ---------------------------------------------------------------------------
// Hybrid retrieval + reranking
// ---------------------------------------------------------------------------

export type RetrievalMode = "vector" | "lexical" | "hybrid";

/**
 * Pluggable reranker. The default is a deterministic, network-free heuristic;
 * real cross-encoder providers (Cohere, Voyage) implement this and are selected
 * by config when an API key is present.
 */
export interface RerankProvider {
  readonly name: string;
  rerank(query: string, hits: VectorSearchHit[], topK: number): Promise<VectorSearchHit[]>;
}

// ---------------------------------------------------------------------------
// LLM-based structured extraction (cf. Firecrawl /extract)
// ---------------------------------------------------------------------------

export interface StructuredExtractionResult {
  sourceUrl: string;
  finalUrl: string;
  provider: string;
  model?: string;
  data: Record<string, unknown>;
  governanceStatus: GovernanceDecision["status"];
  skipped?: boolean;
  reason?: string;
  usage?: Record<string, number>;
}

/**
 * A persisted structured extraction: the extraction result plus storage
 * identity (id), the hash of the schema it was extracted against, the optional
 * source content hash it was derived from, and when it was stored. Persisted
 * with its governanceStatus so reads can apply the secure-by-default contract.
 */
export interface StoredExtraction extends StructuredExtractionResult {
  id: string;
  schemaHash: string;
  contentHash?: string;
  createdAt: string;
}

/**
 * Pluggable structured-extraction backend. Default is "none" (no LLM
 * configured); Anthropic (official SDK) and OpenAI activate when their API key
 * is set.
 */
export interface ExtractionProvider {
  readonly name: string;
  readonly model: string;
  extract(input: {
    markdown: string;
    schema: Record<string, unknown>;
    prompt?: string;
    sourceUrl: string;
  }): Promise<{ data: Record<string, unknown>; usage?: Record<string, number> }>;
}

// ---------------------------------------------------------------------------
// Fast site URL discovery (cf. Firecrawl /map)
// ---------------------------------------------------------------------------

export interface MapRequest {
  url: string;
  limit?: number;
  search?: string;
  includeSubdomains?: boolean;
  useSitemap?: boolean;
  includePaths?: string[];
  excludePaths?: string[];
}

export interface MapResult {
  rootUrl: string;
  count: number;
  urls: string[];
  fromSitemap: number;
  fromLinks: number;
}

// ---------------------------------------------------------------------------
// Fetch provider abstraction + anti-bot (stealth / proxy / challenge / captcha)
// ---------------------------------------------------------------------------

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export interface FetchProviderOptions {
  render: RenderMode;
  timeoutMs?: number;
  waitForSelector?: string;
  includeScreenshot?: boolean;
  actions?: ScrapeAction[];
}

export interface FetchProviderResult {
  resource: FetchedResource;
  rendered: boolean;
  provider: string;
  proxyServer?: string;
  challengePassed?: boolean;
}

/**
 * Pluggable fetch backend. The default is the local engine (static fetch +
 * pooled browser render, with stealth/proxy/challenge handling). The seam lets
 * a future provider delegate to an external scraper without touching the
 * governance/knowledge layers above.
 */
export interface FetchProvider {
  readonly name: string;
  fetch(url: string, options: FetchProviderOptions): Promise<FetchProviderResult>;
}

/**
 * Canonical CAPTCHA kinds the engine can detect. `(string & {})` keeps editor
 * autocomplete for the known values while still accepting novel kinds a custom
 * solver might handle.
 */
export type CaptchaKind = "recaptcha-v2" | "recaptcha-v3" | "hcaptcha" | "turnstile" | "unknown" | (string & {});

/**
 * A detected CAPTCHA challenge handed to a solver. Produced by detection from
 * page content; the engine never fabricates these.
 */
export interface CaptchaChallenge {
  kind: CaptchaKind;
  /** The page URL on which the challenge appears. */
  url: string;
  /** Provider site key extracted from the page, when present. */
  siteKey?: string;
  /** reCAPTCHA v3 action, when applicable. */
  action?: string;
  /** Provider-specific extras (passed through verbatim to the solver). */
  data?: Record<string, unknown>;
}

/** A solved CAPTCHA token to inject back into the page/request. */
export interface CaptchaSolution {
  token: string;
  provider: string;
  solvedAt: string;
}

/**
 * Pluggable CAPTCHA solver (the integration contract — see docs/CAPTCHA.md).
 *
 * The engine ships ONLY a no-op default; solving modern CAPTCHAs requires an
 * external service or model and is intentionally not implemented. Operators who
 * are authorized to access a site and have their own solver register it via
 * `registerCaptchaSolver(name, factory)` and select it with
 * `OCTORYN_SCOUT_CAPTCHA_PROVIDER`.
 *
 * Contract: `solve` returns a {@link CaptchaSolution} on success, or `null` to
 * decline (the engine then proceeds on its non-solving path). It MUST NOT throw
 * for an unsupported challenge — return `null` instead.
 */
export interface CaptchaSolver {
  readonly name: string;
  solve(challenge: CaptchaChallenge): Promise<CaptchaSolution | null>;
}

/** Factory that constructs a {@link CaptchaSolver} (given config at call time). */
export type CaptchaSolverFactory = () => CaptchaSolver;
