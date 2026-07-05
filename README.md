**English** | [简体中文](README.zh-CN.md)

# Octopus Scout

[![CI](https://github.com/octoryn/octopus-scout/actions/workflows/ci.yml/badge.svg)](https://github.com/octoryn/octopus-scout/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/octoryn/octopus-scout?sort=semver)](https://github.com/octoryn/octopus-scout/releases/latest)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](.nvmrc)
[![No Docker required](https://img.shields.io/badge/infra-no%20Docker%20required-success.svg)](#storage)

> **Part of [Octopus Core](https://github.com/octoryn) — the open infrastructure stack for governed AI.** One job per repo, along the agent lifecycle: [Scout](https://github.com/octoryn/octopus-scout) · [Observe](https://github.com/octoryn/octopus-observe) · [Experience](https://github.com/octoryn/octopus-experience) · [Blackboard](https://github.com/octoryn/octopus-blackboard) · [Workstate](https://github.com/octoryn/octopus-workstate) · [Runtime](https://github.com/octoryn/octopus-runtime) · [Replay](https://github.com/octoryn/octopus-replay) — with [Inspect](https://github.com/octoryn/octopus-inspect) governing every stage. The whole stack rides one root primitive, [Evidence](https://github.com/octoryn/octopus-evidence) — the canonical, tamper-evident atom and the root category everything else is built on.
>
> **This repo — Scout · Collect:** Collect evidence, not webpages.

Octoryn Web Ingestion Engine: a governed, auditable, AI-native ingestion pipeline for web pages, PDFs, and knowledge workflows.

This first version optimizes for the normal 80% of the web: fetch, optional browser render, extract, normalize to Markdown/JSON, build evidence anchors, cache/version the result, and expose it through API, CLI, queue, and MCP-compatible tooling.

> 📐 **Architecture, technical notes, and Firecrawl comparison**: see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick Start

Install from npm (published package — CLI, MCP server, and library):

```bash
# global CLI
npm install -g octopus-scout
octopus-scout scrape https://example.com --render static

# or run without installing
npx octopus-scout scrape https://example.com --render static

# wire the MCP server into Claude Desktop / Claude Code
npx octopus-scout-mcp
```

> When installed from npm, run the CLI as `octopus-scout <command>` (or `npx octopus-scout <command>`); the `npm run cli -- <command>` form below is the from-source equivalent.

Or run from source (for development):

```bash
npm install
npm run playwright:install
npm run dev
```

```bash
curl -s http://localhost:8787/health
curl -s http://localhost:8787/scrape \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com","render":"static"}'
```

> 🔒 The SSRF guard blocks private/loopback hosts by default — set
> `OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true` to scrape `localhost` or other private
> addresses during local dev and tests.

CLI:

```bash
npm run cli -- scrape https://example.com --render static
npm run cli -- sitemap https://example.com/sitemap.xml
npm run cli -- map https://example.com --search docs --limit 100
npm run cli -- crawl https://example.com --max-depth 1 --max-pages 25
npm run cli -- export https://example.com --embed --jsonl
npm run cli -- ingest https://example.com
npm run cli -- search "what is this page about" --top-k 5 --mode hybrid
npm run cli -- extract https://example.com --schema '{"type":"object","properties":{"title":{"type":"string"}}}'
npm run cli -- ingest-site https://example.com --max-depth 1 --max-pages 25
npm run cli -- crawl https://example.com --resume <crawlId>
npm run cli -- crawls
npm run cli -- retention --snapshot-versions 5 --audit-days 90
npm run cli -- refresh --max-age-days 7
npm run cli -- approvals pending
npm run cli -- approve <approval-id> --by you@org.com --note "reviewed"
```

Use as a library:

The package (`octopus-scout`) exposes the engine through its `dist/index.js` entrypoint,
so you can call the pipeline directly instead of going through the HTTP/CLI/MCP surfaces:

```ts
import { scrapeUrl, searchKnowledge } from "octopus-scout";

const result = await scrapeUrl({ url: "https://example.com", render: "static" });
console.log(result.extraction.markdown);

const hits = await searchKnowledge({ query: "what is this page about", topK: 5 });
console.log(hits);
```

### Storage

No Docker or external database is required. By default octopus-scout uses an
embedded **SQLite** database (a single `octopus-scout.db` file under the data
dir) for snapshots, vectors, audit, approvals, and crawl jobs — clone and run.

> **Works on any platform.** SQLite is provided by the optional native module
> `better-sqlite3`; `npm install` never fails if it can't build, and at runtime
> octopus-scout uses SQLite when the driver is available and otherwise
> transparently falls back to the file backend (with a one-time notice). So the
> clone-and-run promise holds even where no prebuilt binary or build toolchain
> exists.

- Set `OCTORYN_SCOUT_STORAGE_BACKEND=file` for the plain-JSON fallback (files
  under `.octoryn-scout/`).
- Set `DATABASE_URL=postgres://...` to use **Postgres + pgvector** instead,
  for large corpora or multi-instance deployments. When `REDIS_URL` is set,
  `/jobs/scrape` and `npm run worker` use BullMQ for durable queues.

Postgres and Redis are entirely optional; bring them in only when you outgrow
the embedded defaults:

```bash
docker compose up
```

## API

Ingestion:

- `GET /health`
- `POST /fetch` static fetch with robots and rate-limit policy
- `POST /render` Playwright browser render
- `POST /scrape` full ingestion pipeline (hash dedup + governance gating; supports pre-scrape `actions` on browser renders)
- `POST /sitemap` sitemap URL extraction
- `POST /map` fast site URL discovery (sitemap + root-page links, same-origin/subdomain + path/search filters) — cf. Firecrawl `/map`
- `POST /crawl` depth-bounded crawl (BFS, sitemap seed, same-origin + regex filters; `resumeCrawlId` to continue a checkpointed crawl)
- `GET /crawls` / `GET /crawls/:id` list / read persisted crawl jobs
- `POST /jobs/scrape` / `POST /jobs/crawl` / `POST /jobs/ingest-site` enqueue durable jobs when Redis is configured
- `GET /jobs/:id?queue=scrape|crawl|site|dead` job state / result / failure

Knowledge & retrieval:

- `POST /export` chunk + (optionally) embed a page into a RAG document / JSONL
- `POST /ingest` scrape → chunk → embed → store into the vector index
- `POST /ingest-site` crawl a whole site and index every page into the vector store
- `POST /search` retrieval over the knowledge base — `mode` = `vector` | `lexical` | `hybrid` (default), optional `rerank`; returns chunks with citation anchors, trust, and governance status
- `POST /extract` LLM structured extraction — scrape a URL and return JSON conforming to a supplied JSON Schema (cf. Firecrawl `/extract`)
- `POST /extract/batch` run the same JSON Schema extraction over an explicit list of URLs (one result per input URL)
- `POST /extract/site` discover a site's URLs (`/map`) and extract the schema from each page
- `GET /extractions` list persisted extractions (governed reads: non-`allowed` excluded by default; `includeUnapproved` opt-in)
- `GET /extractions/:id` read one persisted extraction by id
- `GET /versions?url=` version history (content-hash snapshots) for a URL
- `GET /snapshots/:id` read a saved snapshot

Governance & operations:

- `GET /governance/approvals?status=` list approval requests (pending/approved/rejected)
- `GET /governance/approvals/:id` read one approval request
- `POST /governance/approvals/:id/decision` approve/reject (records an audit event)
- `GET /audit?target=&action=` query the append-only audit trail
- `POST /admin/retention` prune old snapshot versions, audit events, and decided approvals
- `POST /admin/refresh` run a staleness sweep — re-ingest snapshots older than a threshold
- `GET /events` tail recent internal events (scrape/approval/crawl/ingest)
- `GET /webhooks` webhook delivery log (status, attempts, response code)
- `GET /metrics` (`?format=prometheus`) request/status/governance counters + per-domain stats
- `GET /ready` readiness probe (checks Redis/Postgres reachability when configured)

## Pipeline

```text
URL Input
  -> Fetcher / Browser Renderer (pooled) / Crawler (depth-bounded BFS)
  -> Content Extractor
  -> Markdown / JSON Normalizer
  -> Evidence + Citation Builder
  -> Governance (trust score, sensitive-domain gating, audit, human approval)
  -> Cache / Hash-Dedup / Versioning
  -> Knowledge Pipeline (chunking + embedding hook + RAG/JSONL export)
  -> Agent / RAG / Workflow (CLI, HTTP API, MCP server)
```

## Knowledge & RAG

`POST /export` (or `cli export`) chunks a page's Markdown by heading structure into
token-bounded, overlapping chunks, maps each chunk back to a citation anchor and to
its character offsets in the source Markdown, and emits a `RagDocument` (or JSONL, one
line per chunk).

`POST /ingest` runs the full read-path — scrape → chunk → embed → store — into a vector
index, and `POST /search` retrieves the nearest chunks for a query, each carrying its
source URL, citation anchor, trust score, and governance status. Content blocked by
governance is never indexed; `requires_approval` content is indexed with its status so
search can filter it (`includeBlocked`, `minTrust`, `url`).

Retrieval (`POST /search`) supports three modes: `vector` (embedding cosine),
`lexical` (SQLite FTS5 by default, in-memory BM25 on the file backend, Postgres full-text on Postgres), and
`hybrid` (default) which fuses both candidate sets with **Reciprocal Rank Fusion**.
Results then pass through a pluggable reranker (`OCTORYN_SCOUT_RERANK_PROVIDER` =
`heuristic` default | `cohere` | `voyage` | `none`); the heuristic reranker is
deterministic and offline, and Cohere/Voyage activate when their API key is set.
An optional `rewrite` flag turns on **heuristic query rewriting**: the query is expanded
into a small set of deterministic, offline variants (the original, a normalized form, and a
stopword-stripped keyword form), each searched and the hits fused — no LLM call, no key.

`POST /extract` (or `cli extract`) performs **LLM structured extraction**: it scrapes a
URL, then returns JSON conforming to a JSON Schema you supply. The provider is pluggable
(`OCTORYN_SCOUT_EXTRACTION_PROVIDER` = `none` default | `anthropic` | `openai` | `bedrock`):
Anthropic uses the official SDK with `claude-opus-4-8` and `output_config` json-schema output,
OpenAI uses json-schema `response_format`, and `bedrock` runs Anthropic models on **Amazon
Bedrock** via a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK` + `OCTORYN_SCOUT_BEDROCK_REGION`,
forced tool-use for JSON, no AWS SDK dependency); governance-blocked pages are skipped, never
extracted.

Extraction also scales beyond a single page: `POST /extract/batch` runs the same schema over
an explicit list of URLs, and `POST /extract/site` first discovers a site's URLs (the `/map`
path) and then extracts the schema from each page — one result per URL, with a single failure
captured as a skipped result rather than aborting the run. Every non-blocked result is
persisted in a **governed `ExtractionStore`** (File / SQLite / Postgres, selected exactly like
the snapshot store) carrying its `governanceStatus`; `GET /extractions` and `GET /extractions/:id`
read them back, excluding non-`allowed` rows by default with an `includeUnapproved` opt-in —
the same secure-by-default contract as search.

> 🔌 **Framework integrations**: to plug the governed retrieval read-path into
> LangChain or LlamaIndex, see [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — a
> framework-agnostic `searchAsDocuments` helper plus copy-paste retriever
> snippets (octopus-scout adds no framework runtime dependency).

Embeddings are produced through a pluggable `EmbeddingProvider`
(`OCTORYN_SCOUT_EMBEDDING_PROVIDER` = `lexical` | `voyage` | `openai`): the default is a
built-in **offline lexical embedder**, and Voyage/OpenAI activate when their API key is set
(`VOYAGE_API_KEY` / `OPENAI_API_KEY`), falling back to the lexical embedder otherwise.

> ✅ **Works out of the box, offline, with no API key.** The default `lexical` embedder is a
> zero-config, deterministic, dependency-free **keyword-overlap retriever** (a BM25-lite
> feature-hashing vectorizer): it tokenizes, hashes tokens into a fixed 256-dim vector with a
> sub-linear term-frequency weight, and L2-normalizes so cosine similarity ranks by weighted
> shared-keyword overlap. `vector` and `hybrid` search return genuinely useful results
> immediately — good enough to be useful out of the box.
>
> ⚠️ **It is NOT semantic.** The lexical embedder does not understand synonyms, paraphrase, or
> cross-lingual meaning. For **true semantic search**, set `OCTORYN_SCOUT_EMBEDDING_PROVIDER`
> to `voyage` or `openai` (with the matching API key). (`stub` is still accepted as a
> deprecated alias for `lexical`.) The vector store is the embedded **SQLite** backend
> (in-process cosine) by default; when `DATABASE_URL` is set it uses **pgvector** (a
> `vector(dim)` column + HNSW cosine index, `<=>` distance) and transparently falls back to
> jsonb + in-process cosine if the `vector` extension is unavailable.

## Access control

Set `OCTORYN_SCOUT_AUTH_MODE` (`off` | `write` | `all`) and `OCTORYN_SCOUT_API_KEYS`
(comma-separated) to require an API key via `Authorization: Bearer <key>` or
`x-api-key`. `write` protects all mutating requests plus the governance-sensitive
`/governance` and `/audit` reads; `all` protects everything except `GET /health`. With
no keys configured, auth is disabled (backward compatible).

## Per-domain policy

Point `OCTORYN_SCOUT_POLICY_FILE` (or drop `<dataDir>/policy.json`) at a
`GovernancePolicy`: per-domain `action` (`allow` | `block` | `require_approval`),
`rateLimitMs`, and `trustOverride`. Policy escalation is applied on top of the
keyword/robots decision (it can only tighten, never relax a block), with the
most-specific domain match winning.

```json
{
  "version": "v1",
  "defaultAction": "allow",
  "domains": [{ "domain": "example.com", "action": "require_approval", "rateLimitMs": 3000 }]
}
```

## Scale & reliability

- **Browser pool** — a single Chromium instance with a bounded concurrent-page
  semaphore (`OCTORYN_SCOUT_BROWSER_MAX_PAGES`) and idle auto-shutdown.
- **Distributed rate limiting** — per-domain spacing is enforced across processes via
  Redis when `REDIS_URL` is set (atomic EVAL), falling back to in-memory; honors
  robots `crawl-delay`.
- **Dead-letter queue** — scrape/crawl jobs that exhaust retries are pushed to a
  dead-letter queue with a classified failure reason (`timeout`, `robots_blocked`,
  `http_error`, `render_error`, `unknown`).
- **Resumable crawls** — crawl jobs checkpoint their frontier/visited/results to a
  store every `OCTORYN_SCOUT_CRAWL_CHECKPOINT_EVERY` pages; `POST /crawl` with
  `resumeCrawlId` continues from the last checkpoint. `GET /crawls` lists jobs.
- **Whole-site ingestion** — `POST /ingest-site` crawls a site and indexes every
  allowed page into the vector store in one call; `POST /jobs/ingest-site` runs it as a
  durable BullMQ job (poll `GET /jobs/:id`), with exhausted retries routed to the
  dead-letter queue.
- **Distributed scheduler lock** — the scheduled staleness sweep is wrapped in a Redis
  lock (`SET NX PX` + Lua compare-del), so multiple instances don't double-sweep; with no
  Redis it degrades to single-instance run-anyway.
- **Retention** — `POST /admin/retention` (or `cli retention`) prunes snapshot versions
  beyond `OCTORYN_SCOUT_SNAPSHOT_RETENTION_VERSIONS`/`_DAYS`, audit events past
  `OCTORYN_SCOUT_AUDIT_RETENTION_DAYS`, and already-decided approvals (pending approvals
  are never pruned). `0` = keep everything.
- **Observability** — `GET /metrics` (JSON or Prometheus) and `GET /ready`.

## Eventing & automation

The engine emits internal events (`scrape.completed`, `approval.requested`,
`approval.decided`, `crawl.completed`, `site_ingest.completed`) on an in-process bus;
`GET /events` tails them.

- **Webhooks** — set `OCTORYN_SCOUT_WEBHOOK_URLS` (comma list) to forward events as
  JSON POSTs. When `OCTORYN_SCOUT_WEBHOOK_SECRET` is set each delivery carries an
  `x-octoryn-signature: sha256=<hmac>` header for verification; deliveries retry with
  backoff up to `OCTORYN_SCOUT_WEBHOOK_MAX_ATTEMPTS` and are logged at `GET /webhooks`.
  Filter which events fire with `OCTORYN_SCOUT_WEBHOOK_EVENTS`. This closes the
  human-in-the-loop: an `approval.requested` webhook can page a reviewer.
- **Scheduled refresh** — with `OCTORYN_SCOUT_SCHEDULE_ENABLED=true`, a background sweep
  every `OCTORYN_SCOUT_REFRESH_INTERVAL_MS` re-ingests snapshots older than
  `OCTORYN_SCOUT_STALENESS_MAX_AGE_DAYS` (up to `OCTORYN_SCOUT_REFRESH_LIMIT` per run),
  keeping the knowledge base fresh. Trigger manually with `POST /admin/refresh` or
  `cli refresh`.

## Discovery & interaction

- **`POST /map`** (or `cli map`) — fast URL discovery for a site: seeds from sitemaps and
  the root page's links, dedupes, filters by same-origin/subdomain and `includePaths` /
  `excludePaths` / `search`, and caps at `limit`. No per-URL scraping — it's a cheap map.
- **Pre-scrape actions** — `/scrape` and `/render` accept an `actions` array executed in
  order on browser renders before the DOM is captured: `wait`, `waitForSelector`, `click`,
  `scroll`, `type`, `press`, `screenshot` (per-action screenshots returned in
  `actionScreenshots`). Useful for cookie banners, "load more", and tabbed content.
- **Stealth-plus** — `OCTORYN_SCOUT_STEALTH=true` renders with comprehensive,
  hand-rolled (zero-dependency) anti-detection: realistic Chrome UA + UA-CH headers,
  locale/timezone/viewport, automation launch-flag hiding, and an init script that patches
  `navigator.webdriver`/`languages`/`plugins`, stubs `window.chrome`, and spoofs WebGL
  vendor/renderer + `hardwareConcurrency`. `OCTORYN_SCOUT_EXTRA_HEADERS` (JSON) injects
  custom headers on both static fetch and render.
- **BYO proxy** — `OCTORYN_SCOUT_PROXY_URLS` (comma list, `http://user:pass@host:port`)
  routes requests through your proxies with round-robin rotation: Playwright-native on the
  render path, and a hand-rolled `node:net`/`node:tls` **CONNECT tunnel** on the static
  path (zero dependencies). Bring your own proxies — there is no hosted proxy pool.
- **JS-challenge handling** — Cloudflare-style "Just a moment" interstitials are detected
  and waited out by the real browser executing the challenge (no solving). `FetchProvider`
  is a pluggable seam (`LocalFetchProvider` today) for future backends.
- **CAPTCHA** — a `CaptchaSolver` seam exists but ships only a `NoopCaptchaSolver`
  placeholder (TODO). Solving modern CAPTCHAs requires an external service/model and is
  intentionally not built in.
- **Out of scope (by design):** a hosted proxy pool and adversarial-grade anti-bot
  evasion. The stealth + BYO-proxy + challenge-waiting above handle most of the everyday
  web; hard targets behind aggressive bot defenses or CAPTCHAs are not guaranteed.

## Security

- **SSRF protection** — every outbound fetch/render runs through a URL guard that
  rejects non-`http(s)` schemes and any host resolving to a private/loopback/link-local
  address (incl. the cloud metadata IP `169.254.169.254`), defeating DNS-rebinding by
  checking the _resolved_ IP. Override per environment with
  `OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=true` (for localhost dev/tests) or scope with
  `OCTORYN_SCOUT_HOST_ALLOWLIST` / `_BLOCKLIST`.
- **Content limits** — responses over `OCTORYN_SCOUT_MAX_CONTENT_BYTES` are rejected
  (streamed read aborts early), and only `OCTORYN_SCOUT_ALLOWED_CONTENT_TYPES` are
  processed; bodies are charset-decoded from the content-type header.
- **API-key auth** — see Access control above; `/governance`, `/audit`, and `/admin`
  reads/writes are protected in `write` mode.

## MCP server (Claude & Codex)

The engine ships an MCP stdio server exposing eight tools — `octoryn_scrape`,
`octoryn_crawl`, `octoryn_map`, `octoryn_export`, `octoryn_ingest`,
`octoryn_ingest_site`, `octoryn_search`, `octoryn_extract` — so agents can scrape, crawl,
map, ingest, **semantically search the governed knowledge base**, and run structured
extraction directly.

```bash
npm run build         # produces dist/mcp.js
npx octopus-scout-mcp  # or: node dist/mcp.js
```

Ready-to-paste configs live in [`docs/mcp/`](docs/mcp/) (Claude Code `.mcp.json`,
Claude Desktop, Codex `config.toml`); full guide in [docs/MCP.md](docs/MCP.md).

## Governance Defaults

The engine respects `robots.txt` by default, applies per-domain rate limiting, records
content hashes and source metadata, creates citation anchors from extracted Markdown,
and assigns a basic source trust score.

Medical/legal/financial content is flagged as `requires_approval`: a pending
`ApprovalRecord` is created and the page waits for a human decision via
`/governance/approvals/:id/decision` (or `cli approve/reject`). Every scrape, approval
request, and decision is written to an append-only **audit trail** (`/audit`).
`OCTORYN_SCOUT_APPROVAL_MODE` (`off` | `flag` | `enforce`) controls how strict gating is.

Re-scraping unchanged content is **deduplicated** by content hash, and each distinct
version is retained as a queryable snapshot (`/versions?url=`).

These policies are intentionally conservative and easy to replace with stricter Octoryn governance rules.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and the local check gate
(`typecheck` + `format:check` + `test`). Security issues: please follow
[SECURITY.md](SECURITY.md) rather than opening a public issue.

## License

[Apache-2.0](LICENSE) © Octoryn. A permissive license — use, modify, and distribute
(including in commercial and closed-source products) under its terms; you must preserve the
license and attribution notices.
