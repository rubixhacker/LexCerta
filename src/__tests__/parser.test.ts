import { describe, expect, it } from "vitest";
import { parseCitation } from "../parser/index";

describe("parseCitation", () => {
	describe("standard parsing", () => {
		it("parses '123 S. Ct. 456' into structured object", () => {
			const result = parseCitation("123 S. Ct. 456");
			expect(result).toEqual({
				ok: true,
				citation: {
					volume: 123,
					reporter: "S. Ct.",
					page: 456,
					raw: "123 S. Ct. 456",
					normalized: "123 S. Ct. 456",
				},
			});
		});
	});

	describe("normalization equivalence", () => {
		it("normalizes '123 S Ct 456' to same result as '123 S. Ct. 456'", () => {
			const withPeriods = parseCitation("123 S. Ct. 456");
			const withoutPeriods = parseCitation("123 S Ct 456");
			expect(withPeriods.ok).toBe(true);
			expect(withoutPeriods.ok).toBe(true);
			if (withPeriods.ok && withoutPeriods.ok) {
				expect(withoutPeriods.citation.volume).toBe(withPeriods.citation.volume);
				expect(withoutPeriods.citation.reporter).toBe(withPeriods.citation.reporter);
				expect(withoutPeriods.citation.page).toBe(withPeriods.citation.page);
				expect(withoutPeriods.citation.normalized).toBe(withPeriods.citation.normalized);
			}
		});
	});

	describe("error cases", () => {
		it("returns error for gibberish input", () => {
			const result = parseCitation("not a citation");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("PARSE_ERROR");
				expect(result.error.message).toContain("Could not parse");
			}
		});

		it("returns error for empty input", () => {
			const result = parseCitation("");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("PARSE_ERROR");
				expect(result.error.message).toMatch(/empty/i);
			}
		});

		it("returns error for unrecognized reporter", () => {
			const result = parseCitation("123 Xyz. Rptr. 456");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.code).toBe("PARSE_ERROR");
				expect(result.error.message).toContain("Unrecognized reporter");
			}
		});
	});

	describe("all standard West reporters", () => {
		const standardReporters: [string, string][] = [
			["347 U.S. 483", "U.S."],
			["123 S. Ct. 456", "S. Ct."],
			["100 L. Ed. 200", "L. Ed."],
			["100 L. Ed. 2d 200", "L. Ed. 2d"],
			["500 F. 100", "F."],
			["500 F.2d 100", "F.2d"],
			["300 F.3d 200", "F.3d"],
			["50 F.4th 100", "F.4th"],
			["200 F. Supp. 100", "F. Supp."],
			["150 F. Supp. 2d 300", "F. Supp. 2d"],
			["150 F. Supp. 3d 300", "F. Supp. 3d"],
			["100 A. 200", "A."],
			["100 A.2d 200", "A.2d"],
			["100 A.3d 200", "A.3d"],
			["100 N.E. 200", "N.E."],
			["100 N.E.2d 200", "N.E.2d"],
			["100 N.E.3d 200", "N.E.3d"],
			["100 N.W. 200", "N.W."],
			["100 N.W.2d 200", "N.W.2d"],
			["100 P. 200", "P."],
			["100 P.2d 200", "P.2d"],
			["100 P.3d 200", "P.3d"],
			["100 S.E. 200", "S.E."],
			["100 S.E.2d 200", "S.E.2d"],
			["100 S.W. 200", "S.W."],
			["100 S.W.2d 200", "S.W.2d"],
			["100 S.W.3d 200", "S.W.3d"],
			["100 So. 200", "So."],
			["100 So. 2d 200", "So. 2d"],
			["100 So. 3d 200", "So. 3d"],
		];

		it.each(standardReporters)("recognizes '%s' as reporter '%s'", (input, expectedReporter) => {
			const result = parseCitation(input);
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.citation.reporter).toBe(expectedReporter);
			}
		});
	});

	describe("variant normalization", () => {
		it("normalizes 'S Ct' (no periods) to 'S. Ct.'", () => {
			const result = parseCitation("123 S Ct 456");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.citation.reporter).toBe("S. Ct.");
			}
		});

		it("normalizes 'US' (no periods) to 'U.S.'", () => {
			const result = parseCitation("347 US 483");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.citation.reporter).toBe("U.S.");
			}
		});

		it("normalizes 'F2d' (no periods) to 'F.2d'", () => {
			const result = parseCitation("500 F2d 100");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.citation.reporter).toBe("F.2d");
			}
		});

		it("normalizes lowercase 's. ct.' to 'S. Ct.'", () => {
			const result = parseCitation("123 s. ct. 456");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.citation.reporter).toBe("S. Ct.");
			}
		});
	});

	describe("tolerance", () => {
		it("handles pin cite: '347 U.S. 483, 490' parses with page=483", () => {
			const result = parseCitation("347 U.S. 483, 490");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.citation.volume).toBe(347);
				expect(result.citation.reporter).toBe("U.S.");
				expect(result.citation.page).toBe(483);
			}
		});

		it("handles parenthetical: '347 U.S. 483 (1954)' parses with page=483", () => {
			const result = parseCitation("347 U.S. 483 (1954)");
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.citation.volume).toBe(347);
				expect(result.citation.reporter).toBe("U.S.");
				expect(result.citation.page).toBe(483);
			}
		});
	});
});
