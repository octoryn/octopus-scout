[English](INTEGRATIONS.md) | **简体中文**

# 框架集成（LangChain 与 LlamaIndex）

`octopus-scout` 是一个**可治理的知识系统**。其检索读取路径（`searchKnowledge`）
默认安全：被屏蔽（blocked）的内容永远不会被索引，需要审批
（`requires_approval`）的内容除非你显式选择启用，否则会被排除在结果之外。
为了将这种受治理的检索接入 LLM 框架，octopus-scout 仅暴露一个精简的、
与框架无关的辅助函数：

```ts
import { searchAsDocuments } from "octopus-scout/integrations";
// 或从源码引入："./src/integrations.js"

const docs = await searchAsDocuments({ query: "治理是如何工作的？", topK: 5 });
// docs: Array<{ pageContent: string; metadata: Record<string, unknown> }>
```

返回的每个对象在结构上都与 LangChain 的
[`Document`](https://js.langchain.com/docs/concepts/documents) 完全一致：
`pageContent` 是分块文本，`metadata` 携带源 URL、用于深度链接的
`anchor`/`citation`、`trustScore`、`governanceStatus`、相关性 `score`
以及文档/分块的 id。

`searchAsDocuments` 接受与 `searchKnowledge` **完全相同的输入** —— `query`、
`topK`、`mode`（`"vector" | "lexical" | "hybrid"`）、`rerank`、`rewrite`、
`url`、`minTrust`，以及治理开关 `includeUnapproved` / `includeBlocked`。

> **重要：** `langchain` 和 `llamaindex` 是**你的**依赖，而非 octopus-scout
> 的依赖。octopus-scout **不会**新增任何框架运行时依赖 —— 下面的代码片段
> 从你已安装的框架包中导入，并包装这个与框架无关的辅助函数。直接复制到
> 你的应用中即可。

---

## LangChain.js —— 自定义 `BaseRetriever`

在**你的**应用中安装 LangChain（`npm i @langchain/core`），然后将
`searchAsDocuments` 包装进 `BaseRetriever`。由于 `searchAsDocuments` 已经返回
`Document` 形状，映射是一一对应的。

```ts
// retriever.ts（在你的应用中 —— 依赖 @langchain/core，而非 octopus-scout）
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
  /** 选择启用以呈现需要审批的内容（默认安全：关闭）。 */
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
    // searchAsDocuments 已返回 { pageContent, metadata } —— 直接包装即可。
    return results.map((d) => new Document({ pageContent: d.pageContent, metadata: d.metadata }));
  }
}

// 用法：
const retriever = new OctopusScoutRetriever({ topK: 5, mode: "hybrid", rerank: true });
const docs = await retriever.invoke("治理是如何工作的？");
```

---

## LlamaIndex（TypeScript）—— 自定义检索器

在**你的**应用中安装 LlamaIndex（`npm i llamaindex`），然后将
`searchAsDocuments` 适配为 `NodeWithScore` 结果。octopus-scout 的每条命中
`score` 成为节点分数；`pageContent` 成为节点文本；`metadata` 保留在节点上。

```ts
// retriever.ts（在你的应用中 —— 依赖 llamaindex，而非 octopus-scout）
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

// 用法：
const retriever = new OctopusScoutLlamaRetriever({ topK: 5, mode: "hybrid" });
const nodes = await retriever.retrieve({ query: "治理是如何工作的？" });
```

---

## 治理贯穿始终

由于两个包装器都经过 `searchAsDocuments` → `searchKnowledge`，治理契约
得以端到端保留：

- **被屏蔽（blocked）** 的内容从未被索引，因此永远不会出现。
- **需要审批（`requires_approval`）** 的内容会被过滤，除非你传入
  `includeUnapproved: true`（类似地还有 `includeBlocked: true`）。
- 返回的每个文档/节点都携带 `metadata.governanceStatus`，因此你的管线
  可以在下游进行审计、标记或进一步过滤。
