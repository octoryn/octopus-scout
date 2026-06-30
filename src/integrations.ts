import { searchKnowledge, type SearchKnowledgeInput } from "./knowledge/retrieval.js";

/**
 * Framework-agnostic retriever adapter.
 *
 * `octopus-scout` deliberately does NOT depend on LangChain or LlamaIndex at
 * runtime. Instead it exposes a single lean helper, {@link searchAsDocuments},
 * that returns plain objects shaped like a LangChain `Document`
 * (`{ pageContent, metadata }`). Users wrap that helper in their own framework's
 * retriever interface — see `docs/INTEGRATIONS.md` for copy-paste snippets for
 * LangChain.js (`BaseRetriever`) and LlamaIndex. Those frameworks remain the
 * USER's dependencies, never octopus-scout's.
 *
 * The adapter inherits the same secure-by-default governance contract as
 * `searchKnowledge`: blocked content is never indexed, and "requires_approval"
 * content is excluded from results unless the caller opts in via
 * `includeUnapproved` / `includeBlocked`. The per-hit `governanceStatus` is
 * surfaced in `metadata` so downstream pipelines can audit/filter further.
 */

/** A framework-agnostic document, structurally compatible with a LangChain `Document`. */
export interface RetrievedDocument {
  /** The chunk text — what a LangChain retriever would expose as `pageContent`. */
  pageContent: string;
  /** Source/citation/governance metadata carried by the originating search hit. */
  metadata: Record<string, unknown>;
}

/**
 * Run a governed knowledge search and project each hit into the LangChain
 * `Document` shape (`{ pageContent, metadata }`).
 *
 * Accepts the same input as {@link searchKnowledge} (query, topK, mode, rerank,
 * url, minTrust, includeUnapproved, includeBlocked, ...). The chunk text becomes
 * `pageContent`; everything else the hit carries — source URL, anchor/citation,
 * trust score, governance status, relevance score, document/chunk ids, heading
 * path — becomes `metadata`.
 */
export async function searchAsDocuments(input: SearchKnowledgeInput): Promise<RetrievedDocument[]> {
  const result = await searchKnowledge(input);

  return result.hits.map((hit) => ({
    pageContent: hit.content,
    metadata: {
      sourceUrl: hit.sourceUrl,
      finalUrl: hit.finalUrl,
      // A stable anchor for citation/deep-linking back into the source document.
      anchor: hit.anchorId,
      citation: hit.anchorId ? `${hit.sourceUrl}#${hit.anchorId}` : hit.sourceUrl,
      title: hit.title,
      headingPath: hit.headingPath,
      trustScore: hit.trustScore,
      governanceStatus: hit.governanceStatus,
      score: hit.score,
      documentId: hit.documentId,
      chunkId: hit.chunkId,
      contentHash: hit.contentHash
    }
  }));
}
