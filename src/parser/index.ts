import { normalizeReporter } from "./reporters";
import type { ParseResult, ParsedCitation } from "./types";

export type { ParsedCitation, CitationParseError, ParseResult } from "./types";

/**
 * Match a citation string of the form "volume reporter page [trailing]".
 *
 * Strategy: find all standalone number tokens after the volume. Try each as
 * the page number (left to right), treating everything between the volume and
 * that number as the reporter text. Accept the FIRST split where the reporter
 * normalizes successfully. This correctly handles series suffixes like "2d"
 * in "F. Supp. 2d" (which are not standalone numbers) and pin cites like
 * "483, 490" (where 483 is tried first and succeeds).
 */
const VOLUME_PREFIX = /^(\d+)\s+/;
function matchCitation(input: string): ParsedCitation | null {
	const volumeMatch = input.match(VOLUME_PREFIX);
	if (!volumeMatch) return null;

	const volume = Number.parseInt(volumeMatch[1], 10);
	const rest = input.slice(volumeMatch[0].length);

	// Find all standalone number positions in the rest of the string.
	// Create regex locally to avoid stale lastIndex state across calls.
	const pageCandidates = /\b(\d+)\b/g;
	let candidate: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: standard regex exec loop
	while ((candidate = pageCandidates.exec(rest)) !== null) {
		const pageStr = candidate[1];
		const pageIndex = candidate.index;

		// Reporter is everything before this number (trimmed)
		const rawReporter = rest.slice(0, pageIndex).trim();
		if (!rawReporter) continue;

		const reporter = normalizeReporter(rawReporter);
		if (reporter) {
			const page = Number.parseInt(pageStr, 10);
			return {
				volume,
				reporter,
				page,
				raw: input,
				normalized: `${volume} ${reporter} ${page}`,
			};
		}
	}

	return null;
}

/**
 * Check if the input has the basic volume+text+number structure (for error messages).
 */
const BASIC_CITATION_REGEX = /^(\d+)\s+(.+)\s+(\d+)/;

/**
 * Parse a legal citation string into a structured ParsedCitation.
 * Normalizes reporter abbreviations to canonical Bluebook forms.
 */
export function parseCitation(input: string): ParseResult {
	const trimmed = input.trim();
	if (!trimmed) {
		return {
			ok: false,
			error: { code: "PARSE_ERROR", message: "Empty input", input },
		};
	}

	const citation = matchCitation(trimmed);
	if (citation) {
		return { ok: true, citation };
	}

	// If regex matched but reporter was unrecognized, provide specific error
	const rawMatch = trimmed.match(BASIC_CITATION_REGEX);
	if (rawMatch) {
		const rawReporter = rawMatch[2].trim();
		return {
			ok: false,
			error: {
				code: "PARSE_ERROR",
				message: `Unrecognized reporter: "${rawReporter}"`,
				input: trimmed,
			},
		};
	}

	return {
		ok: false,
		error: {
			code: "PARSE_ERROR",
			message: `Could not parse "${trimmed}" as a legal citation. Expected format: <volume> <reporter> <page> (e.g., "347 U.S. 483")`,
			input: trimmed,
		},
	};
}
