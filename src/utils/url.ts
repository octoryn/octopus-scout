export function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = "";
  if (url.pathname === "") {
    url.pathname = "/";
  }
  return url.toString();
}

export function domainOf(input: string): string {
  return new URL(input).hostname.toLowerCase();
}

export function sameOriginUrl(input: string, path: string): string {
  const url = new URL(input);
  return new URL(path, `${url.protocol}//${url.host}`).toString();
}

export function isProbablyPdf(url: string, contentType?: string): boolean {
  return (
    Boolean(contentType?.toLowerCase().includes("application/pdf")) ||
    new URL(url).pathname.toLowerCase().endsWith(".pdf")
  );
}
