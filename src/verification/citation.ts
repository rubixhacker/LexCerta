import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export const CONTRACT_VERSION = "1" as const;

export const parseCitationInputSchema = z
	.object({
		citation: z
			.string()
			.min(1)
			.max(256)
			.describe(
				"Case-law citation in volume reporter page form, optionally followed by a pin cite.",
			),
	})
	.strict();

const parsedCitationSchema = z
	.object({
		volume: z.number().int().positive(),
		reporter: z.string().min(1),
		page: z.number().int().positive(),
		normalized: z.string().min(1),
		suffix: z.string(),
	})
	.strict();

const parsedCitationResultSchema = z
	.object({
		outcome: z.literal("parsed"),
		contractVersion: z.literal(CONTRACT_VERSION),
		citation: parsedCitationSchema,
	})
	.strict();

const unrecognizedCitationResultSchema = z
	.object({
		outcome: z.literal("unrecognized"),
		contractVersion: z.literal(CONTRACT_VERSION),
	})
	.strict();

export const parseCitationOutputSchema = z.discriminatedUnion("outcome", [
	parsedCitationResultSchema,
	unrecognizedCitationResultSchema,
]);

export type ParsedCitation = {
	readonly volume: number;
	readonly reporter: string;
	readonly page: number;
	readonly normalized: string;
	readonly suffix: string;
};

export type ParsedCitationResult = {
	readonly outcome: "parsed";
	readonly contractVersion: typeof CONTRACT_VERSION;
	readonly citation: ParsedCitation;
};

export type UnrecognizedCitationResult = {
	readonly outcome: "unrecognized";
	readonly contractVersion: typeof CONTRACT_VERSION;
};

export type CitationParsingResult = ParsedCitationResult | UnrecognizedCitationResult;

type ReporterVariant = {
	readonly key: string;
	readonly reporter: string;
};

const REPORTER_VARIANTS: readonly ReporterVariant[] = [
	{ key: "us", reporter: "U.S." },
	{ key: "u s", reporter: "U.S." },
	{ key: "s ct", reporter: "S. Ct." },
	{ key: "sct", reporter: "S. Ct." },
	{ key: "l ed", reporter: "L. Ed." },
	{ key: "led", reporter: "L. Ed." },
	{ key: "l ed 2d", reporter: "L. Ed. 2d" },
	{ key: "led 2d", reporter: "L. Ed. 2d" },
	{ key: "led2d", reporter: "L. Ed. 2d" },
	{ key: "l ed2d", reporter: "L. Ed. 2d" },
	{ key: "f", reporter: "F." },
	{ key: "f 2d", reporter: "F.2d" },
	{ key: "f2d", reporter: "F.2d" },
	{ key: "f 3d", reporter: "F.3d" },
	{ key: "f3d", reporter: "F.3d" },
	{ key: "f 4th", reporter: "F.4th" },
	{ key: "f4th", reporter: "F.4th" },
	{ key: "f supp", reporter: "F. Supp." },
	{ key: "fsupp", reporter: "F. Supp." },
	{ key: "f supp 2d", reporter: "F. Supp. 2d" },
	{ key: "fsupp 2d", reporter: "F. Supp. 2d" },
	{ key: "fsupp2d", reporter: "F. Supp. 2d" },
	{ key: "f supp 3d", reporter: "F. Supp. 3d" },
	{ key: "fsupp 3d", reporter: "F. Supp. 3d" },
	{ key: "fsupp3d", reporter: "F. Supp. 3d" },
	{ key: "a", reporter: "A." },
	{ key: "a 2d", reporter: "A.2d" },
	{ key: "a2d", reporter: "A.2d" },
	{ key: "a 3d", reporter: "A.3d" },
	{ key: "a3d", reporter: "A.3d" },
	{ key: "n e", reporter: "N.E." },
	{ key: "ne", reporter: "N.E." },
	{ key: "n e 2d", reporter: "N.E.2d" },
	{ key: "ne 2d", reporter: "N.E.2d" },
	{ key: "ne2d", reporter: "N.E.2d" },
	{ key: "n e 3d", reporter: "N.E.3d" },
	{ key: "ne 3d", reporter: "N.E.3d" },
	{ key: "ne3d", reporter: "N.E.3d" },
	{ key: "n w", reporter: "N.W." },
	{ key: "nw", reporter: "N.W." },
	{ key: "n w 2d", reporter: "N.W.2d" },
	{ key: "nw 2d", reporter: "N.W.2d" },
	{ key: "nw2d", reporter: "N.W.2d" },
	{ key: "p", reporter: "P." },
	{ key: "p 2d", reporter: "P.2d" },
	{ key: "p2d", reporter: "P.2d" },
	{ key: "p 3d", reporter: "P.3d" },
	{ key: "p3d", reporter: "P.3d" },
	{ key: "s e", reporter: "S.E." },
	{ key: "se", reporter: "S.E." },
	{ key: "s e 2d", reporter: "S.E.2d" },
	{ key: "se 2d", reporter: "S.E.2d" },
	{ key: "se2d", reporter: "S.E.2d" },
	{ key: "s w", reporter: "S.W." },
	{ key: "sw", reporter: "S.W." },
	{ key: "s w 2d", reporter: "S.W.2d" },
	{ key: "sw 2d", reporter: "S.W.2d" },
	{ key: "sw2d", reporter: "S.W.2d" },
	{ key: "s w 3d", reporter: "S.W.3d" },
	{ key: "sw 3d", reporter: "S.W.3d" },
	{ key: "sw3d", reporter: "S.W.3d" },
	{ key: "so", reporter: "So." },
	{ key: "so 2d", reporter: "So. 2d" },
	{ key: "so2d", reporter: "So. 2d" },
	{ key: "so 3d", reporter: "So. 3d" },
	{ key: "so3d", reporter: "So. 3d" },
] as const;

const VOLUME_PREFIX = /^(\d+)\s+/;
const PAGE_CANDIDATE = /\b(\d+)\b/g;

function normalizedReporterKey(rawReporter: string): string {
	return rawReporter.toLowerCase().replaceAll(".", "").replace(/\s+/g, " ").trim();
}

function recognizedReporter(rawReporter: string): string | undefined {
	const key = normalizedReporterKey(rawReporter);
	return REPORTER_VARIANTS.find((variant) => variant.key === key)?.reporter;
}

function positiveSafeInteger(value: string): number | undefined {
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function unrecognizedCitation(): UnrecognizedCitationResult {
	return { outcome: "unrecognized", contractVersion: CONTRACT_VERSION };
}

export function parseCitation(input: string): CitationParsingResult {
	const citation = input.trimStart();
	const volumeMatch = VOLUME_PREFIX.exec(citation);
	if (volumeMatch === null) return unrecognizedCitation();

	const volumeText = volumeMatch[1];
	if (volumeText === undefined) return unrecognizedCitation();
	const volume = positiveSafeInteger(volumeText);
	if (volume === undefined) return unrecognizedCitation();

	const citationPrefix = volumeMatch[0];
	const remainder = citation.slice(citationPrefix.length);
	for (const candidate of remainder.matchAll(PAGE_CANDIDATE)) {
		const pageText = candidate[1];
		if (pageText === undefined || candidate.index === undefined) continue;

		const reporter = recognizedReporter(remainder.slice(0, candidate.index).trim());
		const page = positiveSafeInteger(pageText);
		if (reporter === undefined || page === undefined) continue;

		return {
			outcome: "parsed",
			contractVersion: CONTRACT_VERSION,
			citation: {
				volume,
				reporter,
				page,
				normalized: `${volume} ${reporter} ${page}`,
				suffix: remainder.slice(candidate.index + pageText.length),
			},
		};
	}

	return unrecognizedCitation();
}

export const parseCitationToolDefinition = {
	title: "Parse citation",
	description:
		"Recognize a supported case-law citation in volume reporter page form. Preserves a trailing pin cite or parenthetical without interpreting it.",
	inputSchema: parseCitationInputSchema,
	outputSchema: parseCitationOutputSchema,
	annotations: {
		title: "Parse citation",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
} as const;

function conciseText(result: CitationParsingResult): string {
	if (result.outcome === "parsed") {
		return `Parsed ${result.citation.normalized}.`;
	}
	return "Citation syntax is not supported by LexCerta.";
}

export function registerParseCitationTool(server: McpServer): void {
	server.registerTool("parse_citation", parseCitationToolDefinition, ({ citation }) => {
		const result = parseCitation(citation);
		return {
			content: [{ type: "text", text: conciseText(result) }],
			structuredContent: result,
			isError: false,
		};
	});
}
