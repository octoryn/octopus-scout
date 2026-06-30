import { describe, expect, it } from "vitest";
import { extractHtml } from "../src/extract/htmlExtractor.js";

describe("extractHtml", () => {
  it("extracts article markdown, links, images, and tables", () => {
    const result = extractHtml(
      `
      <html lang="en">
        <head>
          <title>Scout Test</title>
          <meta name="description" content="A useful test page" />
          <link rel="canonical" href="https://example.com/test" />
        </head>
        <body>
          <article>
            <h1>Scout Test</h1>
            <p>This article has enough content for Readability to extract a useful body.</p>
            <a href="/next">Next</a>
            <figure>
              <img src="/chart.png" alt="Revenue chart" />
              <figcaption>Quarterly revenue</figcaption>
            </figure>
            <table>
              <caption>Metrics</caption>
              <tr><th>Name</th><th>Value</th></tr>
              <tr><td>Coverage</td><td>80%</td></tr>
            </table>
          </article>
        </body>
      </html>
      `,
      "https://example.com/test"
    );

    expect(result.title).toContain("Scout Test");
    expect(result.markdown).toContain("This article has enough content");
    expect(result.links[0].href).toBe("https://example.com/next");
    expect(result.images[0].caption).toBe("Quarterly revenue");
    expect(result.tables[0].headers).toEqual(["Name", "Value"]);
    expect(result.markdown).toContain("Table 1: Metrics");
  });
});
