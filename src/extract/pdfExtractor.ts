import { PDFParse } from "pdf-parse";
import type { ExtractionResult, TableExtract } from "../types.js";
import { normalizeMarkdown } from "./markdown.js";

export async function extractPdf(buffer: Buffer, sourceUrl: string): Promise<ExtractionResult> {
  const parser = new PDFParse({ data: buffer });
  try {
    const [info, textResult, tableResult] = await Promise.all([
      parser.getInfo().catch(() => undefined),
      parser.getText(),
      parser.getTable().catch(() => undefined)
    ]);
    const text = textResult.text.trim();
    const title = typeof info?.info?.Title === "string" ? info.info.Title : undefined;
    const tables = (tableResult?.mergedTables ?? []).map(toTableExtract);

    return {
      kind: "pdf",
      title,
      textContent: text,
      markdown: appendTables(normalizeMarkdown(`# ${title ?? "PDF Document"}\n\n${text}`), tables),
      links:
        info?.pages.flatMap((page) =>
          page.links.map((link) => ({
            href: link.url,
            text: link.text
          }))
        ) ?? [],
      images: [],
      tables,
      metadata: {
        sourceUrl,
        pageCount: info?.total ?? textResult.total,
        info: info?.info,
        fingerprints: info?.fingerprints,
        permissions: info?.permission
      }
    };
  } finally {
    await parser.destroy();
  }
}

function toTableExtract(table: string[][]): TableExtract {
  const [firstRow = [], ...rows] = table;
  return {
    headers: firstRow.map(normalizeCell),
    rows: rows.map((row) => row.map(normalizeCell))
  };
}

function appendTables(markdown: string, tables: TableExtract[]): string {
  if (tables.length === 0) {
    return markdown;
  }

  const rendered = tables.map((table, index) => {
    const width = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 1);
    const headers = padRow(table.headers.length > 0 ? table.headers : [`Column 1`], width);
    return [
      `## PDF Table ${index + 1}`,
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...table.rows.map((row) => `| ${padRow(row, width).join(" | ")} |`)
    ].join("\n");
  });

  return normalizeMarkdown([markdown, ...rendered].join("\n\n"));
}

function padRow(row: string[], width: number): string[] {
  return [...row, ...Array.from({ length: Math.max(0, width - row.length) }, () => "")].slice(0, width);
}

function normalizeCell(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
