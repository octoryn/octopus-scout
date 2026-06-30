import { shortHash } from "../utils/hash.js";
import { chunkMarkdown } from "./chunking.js";
import { getEmbeddingProvider } from "./embedding.js";
import type { EmbeddedChunk, RagDocument, ScrapeResult } from "../types.js";

export interface BuildRagDocumentOptions {
  maxTokens?: number;
  overlapTokens?: number;
  embed?: boolean;
}

/**
 * Turn a ScrapeResult into a chunked (optionally embedded) RAG document.
 *
 * Chunks the extracted markdown with {@link chunkMarkdown}, threading through
 * the evidence anchors / content hash / final URL so chunks carry citation
 * anchor ids. When `embed` is set, chunk contents are embedded via the active
 * {@link getEmbeddingProvider} and attached to each chunk.
 */
export async function buildRagDocument(result: ScrapeResult, options?: BuildRagDocumentOptions): Promise<RagDocument> {
  const finalUrl = result.fetch.finalUrl;
  const contentHash = result.evidence.contentHash;

  const chunking = chunkMarkdown(
    result.extraction.markdown,
    { maxTokens: options?.maxTokens, overlapTokens: options?.overlapTokens },
    {
      sourceUrl: finalUrl,
      contentHash,
      anchors: result.evidence.anchors
    }
  );

  const chunks: EmbeddedChunk[] = chunking.chunks.map((c) => ({ ...c }));

  if (options?.embed && chunks.length > 0) {
    const provider = getEmbeddingProvider();
    const vectors = await provider.embed(chunks.map((c) => c.content));
    for (let i = 0; i < chunks.length; i += 1) {
      if (vectors[i]) {
        chunks[i].embedding = vectors[i];
      }
    }
  }

  return {
    id: shortHash(`${finalUrl} ${contentHash}`),
    sourceUrl: result.request.url,
    finalUrl,
    title: result.extraction.title,
    contentHash,
    capturedAt: result.evidence.capturedAt,
    trust: result.evidence.trust,
    governance: result.evidence.governance,
    chunks
  };
}

/**
 * Serialize a RagDocument to JSONL: one line per chunk, each carrying the chunk
 * fields plus flattened document-level metadata suitable for direct RAG
 * ingestion (vector store upsert, etc.).
 */
export function toJsonl(doc: RagDocument): string {
  return doc.chunks
    .map((chunk) => {
      const record: Record<string, unknown> = {
        id: chunk.id,
        index: chunk.index,
        content: chunk.content,
        tokens: chunk.tokens,
        headingPath: chunk.headingPath,
        charStart: chunk.charStart,
        charEnd: chunk.charEnd,
        anchorId: chunk.anchorId,
        // Document-level metadata, flattened onto every chunk line.
        documentId: doc.id,
        sourceUrl: doc.sourceUrl,
        finalUrl: doc.finalUrl,
        title: doc.title,
        contentHash: doc.contentHash,
        capturedAt: doc.capturedAt,
        trustScore: doc.trust.score,
        trustLabel: doc.trust.label,
        governanceStatus: doc.governance.status
      };
      if (chunk.embedding) {
        record.embedding = chunk.embedding;
      }
      return JSON.stringify(record);
    })
    .join("\n");
}
