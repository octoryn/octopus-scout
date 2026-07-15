**English** | [简体中文](MCP.zh-CN.md)

# Octopus Scout MCP Server

`octopus-scout` ships an [MCP](https://modelcontextprotocol.io) server that exposes
its governed web-ingestion and knowledge-retrieval engine as tools any MCP client
(Claude Code, Claude Desktop, Codex CLI, etc.) can call. It speaks MCP over stdio,
so a client launches it as a subprocess and communicates over stdin/stdout.

- Server name: `octopus-scout`
- Version: `0.1.0`
- Transport: stdio (`StdioServerTransport`)

## Tools

| Tool                  | What it does                                                                                     | Key inputs                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `octoryn_scrape`      | Scrape a URL into governed Markdown/JSON with evidence anchors.                                  | `url` (required), `render` (`auto`\|`static`\|`browser`), `forceRefresh`                               |
| `octoryn_crawl`       | Crawl a site from a root URL, following links depth-bounded, returning a CrawlResult.            | `url` (required), `maxDepth`, `maxPages`                                                               |
| `octoryn_map`         | Fast site URL discovery from sitemap(s) and root-page links, without scraping each page.         | `url` (required), `limit`, `search`, `includeSubdomains`, `useSitemap`, `includePaths`, `excludePaths` |
| `octoryn_export`      | Scrape a URL and build a chunked RAG document with evidence and optional embeddings.             | `url` (required), `embed`                                                                              |
| `octoryn_ingest`      | Scrape, chunk, embed, and index a URL into the vector store for retrieval.                       | `url` (required), `maxTokens`, `overlapTokens`, `forceRefresh`                                         |
| `octoryn_ingest_site` | Crawl a whole site from a root URL and index every page into the vector store.                   | `url` (required), `maxDepth`, `maxPages`, `maxTokens`, `overlapTokens`                                 |
| `octoryn_search`      | Semantic search over indexed knowledge, returning the top matching chunks.                       | `query` (required), `topK`, `url`, `minTrust`, `includeBlocked`                                        |
| `octoryn_extract`     | Scrape a URL and extract structured data into a caller-supplied JSON schema via an LLM provider. | `url` (required), `schema` (required), `prompt`, `forceRefresh`                                        |

Every tool returns its result as a single text content block containing
pretty-printed JSON. Failures are surfaced as MCP tool errors.

## Build & run

Build the TypeScript sources to `dist/` first:

```bash
npm run build
```

Then run the server any of these ways:

```bash
npx octopus-scout-mcp     # uses the bin mapping (octopus-scout-mcp -> dist/mcp.js)
node dist/mcp.js          # run the built file directly
npm run mcp               # run from source via tsx (no build needed)
```

The server reads stdin/stdout and prints nothing useful on its own — point an MCP
client at it instead of running it interactively.

## Environment variables

The server auto-loads `./.env` by default and degrades gracefully without any
configuration (falling back to a local data directory and the offline lexical
embedder). Useful variables:

- `OCTORYN_SCOUT_DATA_DIR` — where snapshots, audit logs, and the local vector
  store live (default `.octoryn-scout`).
- `OCTORYN_SCOUT_ENV_FILE` / `OCTORYN_SCOUT_DISABLE_DOTENV` — choose or disable
  dotenv auto-loading.
- `OCTORYN_SCOUT_EMBEDDING_PROVIDER` — `lexical` (default), `ollama`, `voyage`,
  or `openai`; `stub` is accepted as a deprecated alias for `lexical`.
- `OCTORYN_SCOUT_OLLAMA_URL` — Ollama base URL when `ollama` is selected
  (default `http://127.0.0.1:11434`).
- `OPENAI_API_KEY` — required when the embedding provider is `openai`.
- `VOYAGE_API_KEY` — required when the embedding provider is `voyage`.
- `DATABASE_URL` — Postgres (pgvector) connection string for the shared vector store.
- `REDIS_URL` — Redis connection string for the queue/scheduler.

## Client configuration

In every snippet below, replace `/absolute/path/to/octopus-scout/dist/mcp.js`
with the real absolute path to your built file. Ready-to-paste copies of each
config live alongside this doc:

- `docs/mcp/claude_code.mcp.json`
- `docs/mcp/claude_desktop.json`
- `docs/mcp/codex.config.toml`

### (a) Claude Code — `.mcp.json`

Create a `.mcp.json` in your project root (or merge into an existing one):

```json
{
  "mcpServers": {
    "octopus-scout": {
      "command": "node",
      "args": ["/absolute/path/to/octopus-scout/dist/mcp.js"],
      "env": {
        "OCTORYN_SCOUT_DATA_DIR": "/absolute/path/to/octopus-scout/.octoryn-scout",
        "OPENAI_API_KEY": "sk-...",
        "OCTORYN_SCOUT_EMBEDDING_PROVIDER": "openai"
      }
    }
  }
}
```

### (b) Claude Desktop — `claude_desktop_config.json`

Add the same server block under `mcpServers` in your Claude Desktop config
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "octopus-scout": {
      "command": "node",
      "args": ["/absolute/path/to/octopus-scout/dist/mcp.js"],
      "env": {
        "OCTORYN_SCOUT_DATA_DIR": "/absolute/path/to/octopus-scout/.octoryn-scout",
        "OPENAI_API_KEY": "sk-...",
        "OCTORYN_SCOUT_EMBEDDING_PROVIDER": "openai"
      }
    }
  }
}
```

Restart Claude Desktop after editing the file.

### (c) Codex CLI — `~/.codex/config.toml`

Add these tables to `~/.codex/config.toml`:

```toml
[mcp_servers.octopus-scout]
command = "node"
args = ["/absolute/path/to/octopus-scout/dist/mcp.js"]

[mcp_servers.octopus-scout.env]
OCTORYN_SCOUT_DATA_DIR = "/absolute/path/to/octopus-scout/.octoryn-scout"
OPENAI_API_KEY = "sk-..."
OCTORYN_SCOUT_EMBEDDING_PROVIDER = "openai"
```
