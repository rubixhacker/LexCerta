import { describe, expect, it } from "vitest";
import {
	CONTRACT_VERSION,
	parseCitation,
	parseCitationInputSchema,
	parseCitationOutputSchema,
	parseCitationToolDefinition,
} from "./citation";

describe("parseCitation", () => {
	it("returns a versioned parsed result with normalized base components", () => {
		expect(parseCitation("347 U.S. 483")).toEqual({
			outcome: "parsed",
			contractVersion: CONTRACT_VERSION,
			citation: {
				volume: 347,
				reporter: "U.S.",
				page: 483,
				normalized: "347 U.S. 483",
				suffix: "",
			},
		});
	});

	it("preserves a trailing pin cite and parenthetical without interpreting it", () => {
		expect(parseCitation("347 U.S. 483, 490 (1954) ")).toEqual({
			outcome: "parsed",
			contractVersion: "1",
			citation: {
				volume: 347,
				reporter: "U.S.",
				page: 483,
				normalized: "347 U.S. 483",
				suffix: ", 490 (1954) ",
			},
		});
	});

	it.each([
		["123 us 456", "U.S."],
		["123 u s 456", "U.S."],
		["123 s ct 456", "S. Ct."],
		["123 sct 456", "S. Ct."],
		["123 l ed 456", "L. Ed."],
		["123 led 456", "L. Ed."],
		["123 l ed 2d 456", "L. Ed. 2d"],
		["123 led 2d 456", "L. Ed. 2d"],
		["123 led2d 456", "L. Ed. 2d"],
		["123 l ed2d 456", "L. Ed. 2d"],
		["123 f 456", "F."],
		["123 f 2d 456", "F.2d"],
		["123 f2d 456", "F.2d"],
		["123 f 3d 456", "F.3d"],
		["123 f3d 456", "F.3d"],
		["123 f 4th 456", "F.4th"],
		["123 f4th 456", "F.4th"],
		["123 f supp 456", "F. Supp."],
		["123 fsupp 456", "F. Supp."],
		["123 f supp 2d 456", "F. Supp. 2d"],
		["123 fsupp 2d 456", "F. Supp. 2d"],
		["123 fsupp2d 456", "F. Supp. 2d"],
		["123 f supp 3d 456", "F. Supp. 3d"],
		["123 fsupp 3d 456", "F. Supp. 3d"],
		["123 fsupp3d 456", "F. Supp. 3d"],
		["123 a 456", "A."],
		["123 a 2d 456", "A.2d"],
		["123 a2d 456", "A.2d"],
		["123 a 3d 456", "A.3d"],
		["123 a3d 456", "A.3d"],
		["123 n e 456", "N.E."],
		["123 ne 456", "N.E."],
		["123 n e 2d 456", "N.E.2d"],
		["123 ne 2d 456", "N.E.2d"],
		["123 ne2d 456", "N.E.2d"],
		["123 n e 3d 456", "N.E.3d"],
		["123 ne 3d 456", "N.E.3d"],
		["123 ne3d 456", "N.E.3d"],
		["123 n w 456", "N.W."],
		["123 nw 456", "N.W."],
		["123 n w 2d 456", "N.W.2d"],
		["123 nw 2d 456", "N.W.2d"],
		["123 nw2d 456", "N.W.2d"],
		["123 p 456", "P."],
		["123 p 2d 456", "P.2d"],
		["123 p2d 456", "P.2d"],
		["123 p 3d 456", "P.3d"],
		["123 p3d 456", "P.3d"],
		["123 s e 456", "S.E."],
		["123 se 456", "S.E."],
		["123 s e 2d 456", "S.E.2d"],
		["123 se 2d 456", "S.E.2d"],
		["123 se2d 456", "S.E.2d"],
		["123 s w 456", "S.W."],
		["123 sw 456", "S.W."],
		["123 s w 2d 456", "S.W.2d"],
		["123 sw 2d 456", "S.W.2d"],
		["123 sw2d 456", "S.W.2d"],
		["123 s w 3d 456", "S.W.3d"],
		["123 sw 3d 456", "S.W.3d"],
		["123 sw3d 456", "S.W.3d"],
		["123 so 456", "So."],
		["123 so 2d 456", "So. 2d"],
		["123 so2d 456", "So. 2d"],
		["123 so 3d 456", "So. 3d"],
		["123 so3d 456", "So. 3d"],
	] as const)("normalizes the tested reporter variant %s", (input, reporter) => {
		const result = parseCitation(input);
		expect(result).toMatchObject({ outcome: "parsed" });
		if (result.outcome === "parsed") {
			expect(result.citation.reporter).toBe(reporter);
		}
	});

	it.each(["12 XYZ 34", "410 U.S.C. 1983", "Brown v. Board of Education"])(
		"reports unsupported syntax as unrecognized: %s",
		(input) => {
			expect(parseCitation(input)).toEqual({
				outcome: "unrecognized",
				contractVersion: "1",
			});
		},
	);
});

describe("parse_citation contract schemas", () => {
	it("accepts citations from one through 256 characters and rejects values outside that range", () => {
		expect(parseCitationInputSchema.safeParse({ citation: "x" }).success).toBe(true);
		expect(parseCitationInputSchema.safeParse({ citation: "x".repeat(256) }).success).toBe(true);
		expect(parseCitationInputSchema.safeParse({ citation: "" }).success).toBe(false);
		expect(parseCitationInputSchema.safeParse({ citation: "x".repeat(257) }).success).toBe(false);
	});

	it("accepts only the versioned parsed or unrecognized output forms", () => {
		const parsed = parseCitation("347 U.S. 483");
		const unrecognized = parseCitation("not a citation");

		expect(parseCitationOutputSchema.safeParse(parsed).success).toBe(true);
		expect(parseCitationOutputSchema.safeParse(unrecognized).success).toBe(true);
		expect(
			parseCitationOutputSchema.safeParse({
				outcome: "parsed",
				contractVersion: "2",
			}).success,
		).toBe(false);
	});

	it("declares parse_citation as a read-only, idempotent tool", () => {
		expect(parseCitationToolDefinition.annotations).toEqual({
			title: "Parse citation",
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
	});
});
