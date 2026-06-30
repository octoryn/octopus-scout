**English** | [简体中文](INTEGRATIONS.zh-CN.md)

# Framework Integrations (LangChain & LlamaIndex)

`octopus-scout` is a **governable knowledge system**. Its retrieval read-path
(`searchKnowledge`) is secure-by-default: blocked content is never indexed, and
`requires_approval` content is excluded from results unless you explicitly opt
in. To plug that governed retrieval into an LLM framework, octopus-scout exposes
one lean, framework-agnostic helper:

```ts
import { searchAsDocuments } from "octopus-scout/integrations";
// or, from source: "./src/integrations.js"

const docs = await searchAsDocuments({ query: "how does governance work?", topK: 5 });
// docs: Array<{ pageContent: string; metadata: Record<string, unknown> }>
```

Each returned object is structurally identical to a LangChain
[`Document`](https://js.langchain.com/docs/concepts/documents): `pageContent` is
the chunk text, and `metadata` carries the source URL, an `anchor`/`citation`
for deep-linking, `trustScore`, `governanceStatus`, the relevance `score`, and
the document/chunk ids.

`searchAsDocuments` accepts the **same input as `searchKnowledge`** — `query`,
`topK`, `mode` (`"vector" | "lexical" | "hybrid"`), `rerank`, `rewrite`, `url`,
`minTrust`, and the governance opt-ins `includeUnapproved` / `includeBlocked`.

> **Important:** `langchain` and `llamaindex` are **your** dependencies, not
> octopus-scout's. octopus-scout adds **no** framework runtime dependency — the
> snippets below import from your installed framework package and wrap the
> framework-agnostic helper. Copy them into your app as-is.

---

## LangChain.js — custom `BaseRetriever`

Install LangChain in **your** app (`npm i @langchain/core`), then wrap
`searchAsDocuments` in a `BaseRetriever`. The mapping is 1:1 because
`searchAsDocuments` already returns the `Document` shape.

```ts
// retriever.ts (in YOUR app — depends on @langchain/core, NOT octopus-scout)
import { BaseRetriever, type BaseRetrieverInput } from "@langchain/core/retrievers";
import { Document } from "@langchain/core/documents";
import type { CallbackManagerForRetrieverRun } from "@langchain/core/callbacks/manager";
import { searchAsDocuments } from "octopus-scout/integrations";

export interface OctopusScoutRetrieverInput extends BaseRetrieverInput {
  topK?: number;
  mode?: "vector" | "lexical" | "hybrid";
  rerank?: boolean;
  rewrite?: boolean;
  minTrust?: number;
  /** Opt in to surface requires_approval content (secure-by-default: off). */
  includeUnapproved?: boolean;
}

export class OctopusScoutRetriever extends BaseRetriever {
  lc_namespace = ["octopus-scout", "retrievers"];

  constructor(private readonly opts: OctopusScoutRetrieverInput = {}) {
    super(opts);
  }

  async _getRelevantDocuments(query: string, _runManager?: CallbackManagerForRetrieverRun): Promise<Document[]> {
    const results = await searchAsDocuments({
      query,
      topK: this.opts.topK,
      mode: this.opts.mode,
      rerank: this.opts.rerank,
      rewrite: this.opts.rewrite,
      minTrust: this.opts.minTrust,
      includeUnapproved: this.opts.includeUnapproved
    });
    // searchAsDocuments already returns { pageContent, metadata } — just wrap.
    return results.map((d) => new Document({ pageContent: d.pageContent, metadata: d.metadata }));
  }
}

// Usage:
const retriever = new OctopusScoutRetriever({ topK: 5, mode: "hybrid", rerank: true });
const docs = await retriever.invoke("how does governance work?");
```

---

## LlamaIndex (TypeScript) — custom retriever

Install LlamaIndex in **your** app (`npm i llamaindex`), then adapt
`searchAsDocuments` into `NodeWithScore` results. octopus-scout's per-hit
`score` becomes the node score; `pageContent` becomes the node text; `metadata`
is preserved on the node.

```ts
// retriever.ts (in YOUR app — depends on llamaindex, NOT octopus-scout)
import { BaseRetriever, TextNode, type NodeWithScore } from "llamaindex";
import { searchAsDocuments } from "octopus-scout/integrations";

export interface OctopusScoutLlamaRetrieverOptions {
  topK?: number;
  mode?: "vector" | "lexical" | "hybrid";
  rerank?: boolean;
  rewrite?: boolean;
  minTrust?: number;
  includeUnapproved?: boolean;
}

export class OctopusScoutLlamaRetriever extends BaseRetriever {
  constructor(private readonly opts: OctopusScoutLlamaRetrieverOptions = {}) {
    super();
  }

  async _retrieve(params: { query: string }): Promise<NodeWithScore[]> {
    const results = await searchAsDocuments({
      query: params.query,
      topK: this.opts.topK,
      mode: this.opts.mode,
      rerank: this.opts.rerank,
      rewrite: this.opts.rewrite,
      minTrust: this.opts.minTrust,
      includeUnapproved: this.opts.includeUnapproved
    });

    return results.map((d) => ({
      node: new TextNode({ text: d.pageContent, metadata: d.metadata }),
      score: typeof d.metadata.score === "number" ? d.metadata.score : undefined
    }));
  }
}

// Usage:
const retriever = new OctopusScoutLlamaRetriever({ topK: 5, mode: "hybrid" });
const nodes = await retriever.retrieve({ query: "how does governance work?" });
```

---

## Governance carries through

Because both wrappers go through `searchAsDocuments` → `searchKnowledge`, the
governance contract is preserved end-to-end:

- **Blocked** content was never indexed, so it can never appear.
- **`requires_approval`** content is filtered out unless you pass
  `includeUnapproved: true` (and analogously `includeBlocked: true`).
- Every returned document/node carries `metadata.governanceStatus`, so your
  pipeline can audit, badge, or further filter results downstream.
