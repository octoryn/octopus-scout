# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
semantic versioning once it reaches 1.0.

## [Unreleased]

### Added
- Core ingestion: `/scrape`, `/fetch`, `/render`, static + pooled-browser fetch, HTML/PDF → Markdown, tables, robots.txt + per-domain rate limiting, content-hash dedup, version snapshots, citation anchors, source trust score.
- Crawl: depth-bounded BFS with sitemap seeding, filters, checkpoint/resume; whole-site ingestion; `/map` fast URL discovery.
- Knowledge / RAG: chunking, pluggable embeddings (stub / Voyage / OpenAI), vector store (file cosine / Postgres jsonb / **pgvector**), hybrid retrieval (vector + lexical BM25 + RRF) with pluggable reranking, RAG/JSONL export, `/ingest` + `/search`.
- LLM structured extraction (`/extract`) with Anthropic (official SDK) and OpenAI providers.
- Governance: audit trail, human-approval workflow, per-domain policy, sensitive-domain gating; retention/pruning.
- Eventing: internal event bus, HMAC-signed webhooks, scheduled staleness refresh.
- Distributed: persistent BullMQ jobs (scrape/crawl/site-ingest) + dead-letter queue, Redis distributed lock for the scheduler.
- Anti-bot (zero new dependencies): stealth-plus, BYO proxy with hand-rolled CONNECT tunnel, Cloudflare JS-challenge waiting, `FetchProvider` seam, CAPTCHA provider seam (detection + registry + spec; no solving — see `docs/CAPTCHA.md`).
- Interfaces: HTTP API (Fastify), CLI, MCP stdio server (8 tools); optional API-key auth.

### Security
- SSRF guard re-validates every redirect hop across the direct, proxied, and browser fetch paths.

### Changed
- Pinned all dependencies to caret ranges (was `"latest"`), added publish metadata, `files`/`exports`/type declarations, and a library entry point.
