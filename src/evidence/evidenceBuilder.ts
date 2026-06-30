import type {
  CitationAnchor,
  EvidenceBundle,
  ExtractionResult,
  GovernanceDecision,
  SourceTrustScore
} from "../types.js";
import { sha256, shortHash } from "../utils/hash.js";

const riskKeywords = [
  "medical",
  "medicine",
  "clinical",
  "diagnosis",
  "treatment",
  "patient",
  "legal",
  "lawyer",
  "contract",
  "financial advice",
  "investment",
  "securities"
];

export function buildEvidence(params: {
  sourceUrl: string;
  finalUrl: string;
  extraction: ExtractionResult;
  robotsAllowed: boolean;
}): EvidenceBundle {
  const contentHash = sha256(params.extraction.markdown);
  const trust = scoreSource(params.finalUrl, params.extraction);
  const governance = decideGovernance(params.extraction, params.robotsAllowed, trust);

  return {
    sourceUrl: params.sourceUrl,
    finalUrl: params.finalUrl,
    canonicalUrl: params.extraction.canonicalUrl,
    capturedAt: new Date().toISOString(),
    contentHash,
    anchors: buildCitationAnchors(params.extraction.markdown, params.finalUrl),
    trust,
    governance
  };
}

export function buildCitationAnchors(markdown: string, sourceUrl: string): CitationAnchor[] {
  const anchors: CitationAnchor[] = [];
  const blocks = markdown.split(/\n{2,}/g);
  let offset = 0;

  for (const block of blocks) {
    const trimmed = block.trim();
    const markdownOffset = markdown.indexOf(block, offset);
    offset = markdownOffset + block.length;

    if (trimmed.length < 80 && !trimmed.startsWith("#")) {
      continue;
    }

    const quote = trimmed.replace(/\s+/g, " ").slice(0, 240);
    anchors.push({
      id: `cite_${anchors.length + 1}_${shortHash(`${sourceUrl}:${markdownOffset}:${quote}`, 8)}`,
      sourceUrl,
      textQuote: quote,
      markdownOffset: Math.max(0, markdownOffset)
    });

    if (anchors.length >= 100) {
      break;
    }
  }

  return anchors;
}

export function scoreSource(finalUrl: string, extraction: ExtractionResult): SourceTrustScore {
  const url = new URL(finalUrl);
  const reasons: string[] = [];
  let score = 0.45;

  if (url.protocol === "https:") {
    score += 0.2;
    reasons.push("https source");
  }

  if (["gov", "edu"].some((suffix) => url.hostname.endsWith(`.${suffix}`))) {
    score += 0.15;
    reasons.push("public institution domain");
  }

  if (extraction.canonicalUrl) {
    score += 0.05;
    reasons.push("canonical URL present");
  }

  if (extraction.description || extraction.excerpt) {
    score += 0.05;
    reasons.push("descriptive metadata present");
  }

  if (extraction.markdown.length < 400) {
    score -= 0.15;
    reasons.push("low extracted content volume");
  }

  const clamped = Math.max(0, Math.min(1, Number(score.toFixed(2))));
  return {
    score: clamped,
    label: clamped >= 0.75 ? "high" : clamped >= 0.45 ? "medium" : "low",
    reasons
  };
}

export function decideGovernance(
  extraction: ExtractionResult,
  robotsAllowed: boolean,
  trust: SourceTrustScore
): GovernanceDecision {
  const reasons: string[] = [];

  if (!robotsAllowed) {
    return {
      status: "blocked",
      reasons: ["blocked by robots policy"],
      policyVersion: "governance-v0.1"
    };
  }

  const corpus = `${extraction.title ?? ""}\n${extraction.description ?? ""}\n${extraction.markdown}`.toLowerCase();
  const riskHits = riskKeywords.filter((keyword) => corpus.includes(keyword));

  if (riskHits.length > 0) {
    reasons.push(`sensitive domain terms detected: ${riskHits.slice(0, 5).join(", ")}`);
  }

  if (trust.label === "low") {
    reasons.push("low source trust score");
  }

  return {
    status: reasons.length > 0 ? "requires_approval" : "allowed",
    reasons,
    policyVersion: "governance-v0.1"
  };
}
