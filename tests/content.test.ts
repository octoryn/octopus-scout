import { describe, it, expect } from "vitest";
import {
  isAllowedContentType,
  assertContentLength,
  readBodyCapped,
  decodeBody,
  ContentRejectedError
} from "../src/fetcher/content.js";

describe("isAllowedContentType", () => {
  it("allows text/html with the default allowlist", () => {
    expect(isAllowedContentType("text/html")).toBe(true);
  });

  it("allows application/pdf with the default allowlist", () => {
    expect(isAllowedContentType("application/pdf")).toBe(true);
  });

  it("blocks image/png with the default allowlist", () => {
    expect(isAllowedContentType("image/png")).toBe(false);
  });

  it("allows an empty content-type", () => {
    expect(isAllowedContentType("")).toBe(true);
  });
});

describe("assertContentLength", () => {
  it("throws ContentRejectedError with statusCode 413 when header exceeds max", () => {
    let caught: unknown;
    try {
      assertContentLength("2048", 1024);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContentRejectedError);
    expect((caught as ContentRejectedError).statusCode).toBe(413);
  });

  it("passes when the header is under the max", () => {
    expect(() => assertContentLength("512", 1024)).not.toThrow();
  });

  it("passes when the header is null", () => {
    expect(() => assertContentLength(null, 1024)).not.toThrow();
  });
});

describe("readBodyCapped", () => {
  it("returns the full buffer when the body is under the cap", async () => {
    const text = "hello world";
    const response = new Response(new Blob([text]));
    const buffer = await readBodyCapped(response, 1024);
    expect(buffer.toString("utf8")).toBe(text);
    expect(buffer.byteLength).toBe(Buffer.byteLength(text));
  });

  it("throws ContentRejectedError (413) when the body exceeds maxBytes", async () => {
    const response = new Response("this is definitely larger than the cap");
    let caught: unknown;
    try {
      await readBodyCapped(response, 4);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContentRejectedError);
    expect((caught as ContentRejectedError).statusCode).toBe(413);
  });
});

describe("decodeBody", () => {
  it("decodes UTF-8 by default when no charset is present", () => {
    const buffer = Buffer.from("café résumé", "utf8");
    expect(decodeBody(buffer, "text/html")).toBe("café résumé");
  });

  it("decodes a latin1-encoded buffer with charset=iso-8859-1", () => {
    // 0xE9 = é, 0xF1 = ñ in ISO-8859-1 / latin1.
    const buffer = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x69, 0xf1, 0x6f]);
    expect(decodeBody(buffer, "text/html; charset=iso-8859-1")).toBe("café niño");
  });
});
