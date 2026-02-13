export interface ParsedCitation {
	volume: number;
	reporter: string; // Canonical Bluebook form
	page: number;
	raw: string; // Original input
	normalized: string; // Reconstructed "volume reporter page"
}

export interface CitationParseError {
	code: "PARSE_ERROR";
	message: string;
	input: string;
}

export type ParseResult =
	| { ok: true; citation: ParsedCitation }
	| { ok: false; error: CitationParseError };
