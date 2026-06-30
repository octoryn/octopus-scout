**English** | [简体中文](CHANGELOG.zh-CN.md)

# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
semantic versioning once it reaches 1.0.

## [0.2.0] - 2026-07-01

### Added

- Storage: embedded **SQLite** is now the default backend (zero infrastructure) across all five store families (snapshots, vectors, audit, approvals, crawl jobs), with full File-backend parity. JSON-file fallback via `OCTORYN_SCOUT_STORAGE_BACKEND=file`; optional Postgres + pgvector via `DATABASE_URL`. SQLite ships as an **optional** native dependency — `npm install` never fails to build, and the backend transparently degrades to the file backend when the driver is unavailable.
- Extraction: multi-page (`POST /extract/batch`) and whole-site (`POST /extract/site`) structured extraction; every non-blocked result is persisted in a governed `ExtractionStore` (file/SQLite/Postgres) and read back via `GET /extractions` / `GET /extractions/:id` (non-`allowed` excluded by default, `includeUnapproved` opt-in). New CLI commands + MCP `octoryn_extract_site`.
- Extraction provider `bedrock`: Anthropic models on **Amazon Bedrock** via a Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK` + `OCTORYN_SCOUT_BEDROCK_REGION`), using forced tool-use for JSON — no AWS SDK dependency.
- Retrieval: heuristic **query rewriting** (`rewrite` flag) — deterministic, offline query variants fused with Reciprocal Rank Fusion; no LLM/key required.
- Integrations: `searchAsDocuments` retriever helper returning LangChain `Document`-shaped objects + `docs/INTEGRATIONS.md` with copy-paste LangChain/LlamaIndex adapters (no langchain runtime dependency).
- Docs: all documentation is now **bilingual** (English + 简体中文) with a top-of-file language switcher.

### Changed

- `npm install`/runtime no longer hard-requires a build toolchain: `better-sqlite3` moved to `optionalDependencies`, loaded lazily with a graceful file-backend fallback.

## [0.1.0] - 2026-07-01

First public release.

### Added

- Core ingestion: `/scrape`, `/fetch`, `/render`, static + pooled-browser fetch, HTML/PDF → Markdown, tables, robots.txt + per-domain rate limiting, content-hash dedup, version snapshots, citation anchors, source trust score.
- Crawl: depth-bounded BFS with sitemap seeding, filters, checkpoint/resume; whole-site ingestion; `/map` fast URL discovery.
- Knowledge / RAG: chunking, pluggable embeddings (stub / Voyage / OpenAI), vector store (SQLite / file cosine / Postgres jsonb / **pgvector**), hybrid retrieval (vector + lexical BM25 / SQLite FTS5 + RRF) with pluggable reranking, RAG/JSONL export, `/ingest` + `/search`.
- LLM structured extraction (`/extract`) with Anthropic (official SDK) and OpenAI providers.
- Governance: audit trail, human-approval workflow, per-domain policy, sensitive-domain gating; retention/pruning.
- Eventing: internal event bus, HMAC-signed webhooks, scheduled staleness refresh.
- Distributed: persistent BullMQ jobs (scrape/crawl/site-ingest) + dead-letter queue, Redis distributed lock for the scheduler.
- Anti-bot (zero new dependencies): stealth-plus, BYO proxy with hand-rolled CONNECT tunnel, Cloudflare JS-challenge waiting, `FetchProvider` seam, CAPTCHA provider seam (detection + registry + spec; no solving — see `docs/CAPTCHA.md`).
- Interfaces: HTTP API (Fastify), CLI, MCP stdio server (8 tools); optional API-key auth.
- Storage: **embedded SQLite is the default backend** (single `octopus-scout.db`, zero infrastructure) across all five store families (snapshots, vectors, audit, approvals, crawl jobs); JSON-file fallback (`OCTORYN_SCOUT_STORAGE_BACKEND=file`); optional Postgres + pgvector (`DATABASE_URL`) for large corpora / multi-instance. SQLite ships as an optional native dependency — `npm install` never fails to build, and the backend transparently degrades to file when the driver is unavailable.

### Governance (enforcement)

- Governance now gates **every serving channel**, not just the index: `blocked` content is never persisted or served; `requires_approval` content is excluded from search by default (opt-in `includeUnapproved`), refused by `/export`, redacted by `/snapshots/:id`, and `/render` + `/fetch` apply domain policy (`451` on block).
- `enforce` mode quarantines `requires_approval` content (never indexed until approved); **approve releases** it, **reject purges** it from both the index and the snapshot store; retention prunes the vector store.

### Security

- SSRF guard re-validates every redirect hop across the direct, proxied, and browser fetch paths.
- API-key auth fails **closed** (a configured auth mode with no keys rejects protected routes) and uses constant-time key comparison; 5xx responses no longer leak internal error messages.
- Strict env-boolean parsing (e.g. `OCTORYN_SCOUT_ALLOW_PRIVATE_HOSTS=false` is honored — previously any non-empty value, including `"false"`, disabled the guard).
- Stub embeddings (the offline default) now emit a one-time warning and surface in `/ready`, so silent non-semantic search is no longer a trap.

### Changed

- Pinned all dependencies to caret ranges (was `"latest"`), added publish metadata, `files`/`exports`/type declarations, and a library entry point.
