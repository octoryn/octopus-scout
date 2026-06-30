import { createRequire } from "node:module";
import { loadConfig } from "../config.js";
import { sameOriginUrl } from "../utils/url.js";
import { noteCrawlDelay } from "./rateLimiter.js";

interface RobotsDecision {
  allowed: boolean;
  reason: string;
  robotsUrl?: string;
}

interface Robot {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay?(ua?: string): number | undefined;
}

type RobotsParserFactory = (url: string, robotstxt: string) => Robot;

const require = createRequire(import.meta.url);
const robotsParser = require("robots-parser") as RobotsParserFactory;
const robotsCache = new Map<string, Robot>();
const failedRobotsOrigins = new Set<string>();

export async function canFetchUrl(url: string, respectRobots = true): Promise<RobotsDecision> {
  if (!respectRobots) {
    return { allowed: true, reason: "robots disabled by request" };
  }

  const config = loadConfig();
  const target = new URL(url);
  const origin = target.origin;
  const robotsUrl = sameOriginUrl(url, "/robots.txt");

  let parser = robotsCache.get(origin);
  if (!parser && !failedRobotsOrigins.has(origin)) {
    try {
      const response = await fetch(robotsUrl, {
        signal: AbortSignal.timeout(Math.min(config.defaultTimeoutMs, 5_000)),
        headers: { "user-agent": config.userAgent }
      });
      const body = response.ok ? await response.text() : "";
      parser = robotsParser(robotsUrl, body);
      robotsCache.set(origin, parser);
    } catch {
      failedRobotsOrigins.add(origin);
    }
  }

  if (!parser) {
    return { allowed: true, reason: "robots unavailable; default allow", robotsUrl };
  }

  // Honor any crawl-delay directive by feeding it to the distributed rate limiter.
  try {
    if (typeof parser.getCrawlDelay === "function") {
      const crawlDelaySeconds = parser.getCrawlDelay(config.userAgent);
      if (typeof crawlDelaySeconds === "number" && Number.isFinite(crawlDelaySeconds) && crawlDelaySeconds > 0) {
        noteCrawlDelay(url, crawlDelaySeconds * 1000);
      }
    }
  } catch {
    // Never let crawl-delay bookkeeping break robots evaluation.
  }

  const allowed = parser.isAllowed(url, config.userAgent) !== false;
  return {
    allowed,
    reason: allowed ? "allowed by robots.txt" : "blocked by robots.txt",
    robotsUrl
  };
}
