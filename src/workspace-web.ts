import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function webFetch(url: string): Promise<string> {
  const normalized = normalizeUrl(url);
  const { stdout } = await execFileAsync("curl", [
    "-L",
    "--silent",
    "--show-error",
    "--max-time",
    "20",
    normalized,
  ], { maxBuffer: 2 * 1024 * 1024 });

  const html = stdout.toString();
  const title = extractTitle(html);
  const text = extractVisibleText(html);
  const links = extractLinks(html, normalized);
  return [
    `URL: ${normalized}`,
    title ? `Title: ${title}` : "Title: (not found)",
    links.length > 0 ? `Links: ${links.slice(0, 10).join(" | ")}` : "Links: none",
    "Content:",
    truncateText(text, 12000),
  ].join("\n");
}

export async function webSearch(query: string): Promise<string> {
  const normalized = query.trim();
  if (!normalized) {
    throw new Error("Search query is required.");
  }

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(normalized)}`;
  const { stdout } = await execFileAsync("curl", [
    "-L",
    "--silent",
    "--show-error",
    "--max-time",
    "20",
    url,
  ], { maxBuffer: 2 * 1024 * 1024 });

  const html = stdout.toString();
  const results = extractSearchResults(html).slice(0, 8);
  return [
    `Query: ${normalized}`,
    results.length > 0 ? results.map((result, index) => `${index + 1}. ${result.title}\n   ${result.url}`).join("\n") : "No results found.",
  ].join("\n");
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("URL is required.");
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed);
  return hasScheme ? trimmed : `https://${trimmed}`;
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>(.*?)<\/title>/i);
  return decodeHtml(match?.[1] ?? "").trim();
}

function extractVisibleText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  text = decodeHtml(text);
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
    const raw = match[1];
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("mailto:")) {
      continue;
    }

    try {
      links.add(new URL(raw, baseUrl).toString());
    } catch {
      // ignore malformed urls
    }
  }
  return Array.from(links);
}

function extractSearchResults(html: string): Array<{ title: string; url: string }> {
  const results: Array<{ title: string; url: string }> = [];
  const pattern = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = decodeHtml(match[1] ?? "");
    const title = stripTags(decodeHtml(match[2] ?? "")).trim();
    if (url && title) {
      results.push({ title, url });
    }
  }
  return results;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated ${value.length - maxLength} chars]`;
}
