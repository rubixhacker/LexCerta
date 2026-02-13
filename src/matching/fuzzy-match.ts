import { partial_ratio, ratio } from "fuzzball";
import type { OpinionText } from "../clients/courtlistener.js";

export interface MatchResult {
	score: number; // 0-100
	classification: "high" | "medium" | "low"; // high: 90+, medium: 70-89, low: <70
	bestMatchExcerpt: string; // best-matching substring with ~50 chars context
	shortQuoteWarning?: boolean;
}

export interface BestMatchResult extends MatchResult {
	matchedOpinionId: number;
	matchedOpinionType: string;
}

/**
 * Normalize text for fuzzy comparison: collapse whitespace, normalize
 * smart quotes, em/en dashes, and non-breaking spaces.
 */
export function normalizeText(text: string): string {
	return (
		text
			// Smart single quotes -> straight
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes -> straight
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Em-dash and en-dash -> hyphen
			.replace(/[\u2013\u2014]/g, "-")
			// Non-breaking space -> regular space
			.replace(/\u00A0/g, " ")
			// Collapse all whitespace
			.replace(/\s+/g, " ")
			.trim()
	);
}

function classify(score: number): "high" | "medium" | "low" {
	if (score >= 90) return "high";
	if (score >= 70) return "medium";
	return "low";
}

/**
 * Extract the best-matching excerpt from opinionText for a given quote,
 * including ~50 chars of surrounding context.
 */
function extractExcerpt(normalizedQuote: string, normalizedOpinion: string): string {
	const quoteLen = normalizedQuote.length;
	const contextChars = 50;

	// For very long texts, chunk into paragraphs to avoid O(n*m)
	if (normalizedOpinion.length > 50_000) {
		const paragraphs = normalizedOpinion.split(/\n\n+/);
		let bestScore = 0;
		let bestParagraph = paragraphs[0] || "";
		for (const para of paragraphs) {
			if (para.length < 10) continue;
			const score = partial_ratio(normalizedQuote, para);
			if (score > bestScore) {
				bestScore = score;
				bestParagraph = para;
			}
		}
		return extractExcerptFromChunk(normalizedQuote, bestParagraph, quoteLen, contextChars);
	}

	return extractExcerptFromChunk(normalizedQuote, normalizedOpinion, quoteLen, contextChars);
}

function extractExcerptFromChunk(
	normalizedQuote: string,
	chunk: string,
	quoteLen: number,
	contextChars: number,
): string {
	// Sliding window to find best match position
	const windowSize = Math.min(quoteLen, chunk.length);
	let bestScore = 0;
	let bestPos = 0;
	const step = Math.max(1, Math.floor(windowSize / 4));

	for (let i = 0; i <= chunk.length - windowSize; i += step) {
		const window = chunk.substring(i, i + windowSize);
		const score = ratio(normalizedQuote, window);
		if (score > bestScore) {
			bestScore = score;
			bestPos = i;
		}
	}

	// Refine: search around bestPos with step=1
	const refineStart = Math.max(0, bestPos - step);
	const refineEnd = Math.min(chunk.length - windowSize, bestPos + step);
	for (let i = refineStart; i <= refineEnd; i++) {
		const window = chunk.substring(i, i + windowSize);
		const score = ratio(normalizedQuote, window);
		if (score > bestScore) {
			bestScore = score;
			bestPos = i;
		}
	}

	const excerptStart = Math.max(0, bestPos - contextChars);
	const excerptEnd = Math.min(chunk.length, bestPos + windowSize + contextChars);
	return chunk.substring(excerptStart, excerptEnd);
}

/**
 * Match a quote against a single opinion's text.
 * Returns a 0-100 score, classification, and best-match excerpt.
 */
export function matchQuoteInOpinion(quote: string, opinionText: string): MatchResult {
	const normalizedQuote = normalizeText(quote);
	const normalizedOpinion = normalizeText(opinionText);
	const shortQuoteWarning = normalizedQuote.length < 20;

	const score = partial_ratio(normalizedQuote, normalizedOpinion);
	const bestMatchExcerpt = extractExcerpt(normalizedQuote, normalizedOpinion);

	return {
		score,
		classification: classify(score),
		bestMatchExcerpt,
		...(shortQuoteWarning ? { shortQuoteWarning: true } : {}),
	};
}

/**
 * Match a quote across multiple opinions and return the best match
 * with the matched opinion's metadata.
 */
export function matchQuoteAcrossOpinions(quote: string, opinions: OpinionText[]): BestMatchResult {
	let bestResult: MatchResult = {
		score: 0,
		classification: "low",
		bestMatchExcerpt: "",
	};
	let bestOpinion: OpinionText = opinions[0];

	for (const opinion of opinions) {
		const result = matchQuoteInOpinion(quote, opinion.plainText);
		if (result.score > bestResult.score) {
			bestResult = result;
			bestOpinion = opinion;
		}
	}

	return {
		...bestResult,
		matchedOpinionId: bestOpinion.opinionId,
		matchedOpinionType: bestOpinion.type,
	};
}
