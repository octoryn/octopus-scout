import { loadConfig } from "../config.js";

/**
 * Content size / type guards and charset-aware body decoding.
 *
 * These helpers let the HTTP fetcher pre-check the content-type and
 * content-length headers, read the response body with a hard byte cap, and
 * decode the resulting bytes into a string using the charset advertised in the
 * content-type header. They never reach out to the network or throw at import.
 */

/**
 * Error raised when a response is rejected for being an unsupported type (415)
 * or exceeding the configured maximum size (413). The HTTP status to surface is
 * carried on `statusCode`.
 */
export class ContentRejectedError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: 413 | 415) {
    super(message);
    this.name = "ContentRejectedError";
    this.statusCode = statusCode;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, ContentRejectedError.prototype);
  }
}

/**
 * Returns true if `contentType` (case-insensitively) contains any of the
 * comma-separated `allowed` substrings. An empty / missing content-type is
 * allowed (true) so we do not over-block servers that omit the header.
 */
export function isAllowedContentType(contentType: string, allowed: string = loadConfig().allowedContentTypes): boolean {
  const value = (contentType ?? "").trim().toLowerCase();
  if (value === "") {
    return true;
  }
  const needles = allowed
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (needles.length === 0) {
    return true;
  }
  return needles.some((needle) => value.includes(needle));
}

/**
 * Throws ContentRejectedError(413) if the `content-length` header parses to a
 * finite number greater than `maxBytes`. A missing / non-numeric header is a
 * no-op (we cannot decide up front, so we rely on the streamed cap instead).
 */
export function assertContentLength(headerValue: string | null, maxBytes: number = loadConfig().maxContentBytes): void {
  if (headerValue == null) {
    return;
  }
  const trimmed = headerValue.trim();
  if (trimmed === "") {
    return;
  }
  const declared = Number(trimmed);
  if (!Number.isFinite(declared) || declared < 0) {
    return;
  }
  if (declared > maxBytes) {
    throw new ContentRejectedError(`Declared content-length ${declared} exceeds maximum ${maxBytes} bytes`, 413);
  }
}

/**
 * Reads the response body, aborting once accumulated bytes exceed `maxBytes`
 * (throwing ContentRejectedError 413). When `response.body` is not a readable
 * stream, falls back to `arrayBuffer()` and checks `byteLength`. Always returns
 * a Buffer.
 */
export async function readBodyCapped(
  response: Response,
  maxBytes: number = loadConfig().maxContentBytes
): Promise<Buffer> {
  const body = response.body;

  // Fallback path: no readable stream available (e.g. polyfilled Response).
  if (!body || typeof (body as ReadableStream<Uint8Array>).getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ContentRejectedError(`Response body ${buffer.byteLength} exceeds maximum ${maxBytes} bytes`, 413);
    }
    return buffer;
  }

  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      total += value.length;
      if (total > maxBytes) {
        // Stop pulling further data and release the stream.
        await reader.cancel().catch(() => {});
        throw new ContentRejectedError(`Response body exceeds maximum ${maxBytes} bytes`, 413);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

/**
 * Extracts a normalized charset label (lowercased, unquoted) from a
 * content-type header, or undefined when none is present.
 */
function parseCharset(contentType: string): string | undefined {
  const match = /charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? "");
  if (!match) {
    return undefined;
  }
  const label = match[1]?.trim().toLowerCase();
  return label && label.length > 0 ? label : undefined;
}

/**
 * Decodes `buffer` into a string using the charset advertised in
 * `contentType`. Defaults to UTF-8; supports common labels (utf-8, latin1 /
 * iso-8859-1, ascii, utf-16le, etc.) and falls back to UTF-8 for unknown or
 * unsupported labels. Never throws on an unknown charset.
 */
export function decodeBody(buffer: Buffer, contentType: string): string {
  const charset = parseCharset(contentType);

  if (!charset || charset === "utf-8" || charset === "utf8" || charset === "unicode-1-1-utf-8") {
    return buffer.toString("utf8");
  }

  switch (charset) {
    case "latin1":
    case "iso-8859-1":
    case "iso8859-1":
    case "windows-1252":
    case "cp1252":
      // Node treats "latin1"/"binary" as single-byte; windows-1252 is a close
      // superset and decoding it as latin1 is the pragmatic best-effort here.
      return buffer.toString("latin1");
    case "ascii":
    case "us-ascii":
      return buffer.toString("ascii");
    case "utf-16le":
    case "utf16le":
    case "ucs-2":
    case "ucs2":
      return buffer.toString("utf16le");
    default:
      break;
  }

  // Try the platform TextDecoder for anything Node's Buffer cannot handle
  // (e.g. utf-16be, shift_jis on ICU-enabled builds). Fall back to UTF-8.
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}
