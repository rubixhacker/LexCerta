import { describe, expect, it } from "vitest";
import type { OpinionText } from "../../clients/courtlistener.js";
import { matchQuoteAcrossOpinions, matchQuoteInOpinion, normalizeText } from "../fuzzy-match.js";

describe("normalizeText", () => {
	it("collapses whitespace", () => {
		expect(normalizeText("hello   world\t\nfoo")).toBe("hello world foo");
	});

	it("converts smart quotes to straight quotes", () => {
		expect(normalizeText("\u2018single\u2019 and \u201Cdouble\u201D")).toBe(
			"'single' and \"double\"",
		);
	});

	it("converts em-dashes and en-dashes to hyphens", () => {
		expect(normalizeText("word\u2014word and word\u2013word")).toBe("word-word and word-word");
	});
});

describe("matchQuoteInOpinion", () => {
	const sampleOpinion =
		"The Court holds that separate educational facilities are inherently unequal. " +
		"Therefore, we hold that the plaintiffs and others similarly situated are, " +
		"by reason of the segregation complained of, deprived of the equal protection " +
		"of the laws guaranteed by the Fourteenth Amendment.";

	it("verbatim quote returns score 95+ and classification high", () => {
		const quote = "separate educational facilities are inherently unequal";
		const result = matchQuoteInOpinion(quote, sampleOpinion);

		expect(result.score).toBeGreaterThanOrEqual(95);
		expect(result.classification).toBe("high");
	});

	it("quote with extra spaces returns score 85+ (fuzzy handles it)", () => {
		const quote = "separate  educational   facilities  are  inherently  unequal";
		const result = matchQuoteInOpinion(quote, sampleOpinion);

		// After normalization, this should be exact match
		expect(result.score).toBeGreaterThanOrEqual(85);
	});

	it("fabricated quote returns score <50 and classification low", () => {
		const quote = "the quantum mechanical properties of subatomic particles demonstrate that";
		const result = matchQuoteInOpinion(quote, sampleOpinion);

		expect(result.score).toBeLessThan(50);
		expect(result.classification).toBe("low");
	});

	it("bestMatchExcerpt contains relevant text from opinion", () => {
		const quote = "separate educational facilities are inherently unequal";
		const result = matchQuoteInOpinion(quote, sampleOpinion);

		expect(result.bestMatchExcerpt).toContain("inherently unequal");
	});

	it("short quote (<20 chars) sets shortQuoteWarning", () => {
		const quote = "The Court holds";
		const result = matchQuoteInOpinion(quote, sampleOpinion);

		expect(result.shortQuoteWarning).toBe(true);
	});
});

describe("matchQuoteAcrossOpinions", () => {
	it("returns best match across multiple opinions with correct opinionId", () => {
		const opinions: OpinionText[] = [
			{
				opinionId: 10,
				type: "020lead",
				plainText: "The majority opinion discusses commerce and trade regulations at length.",
				clusterId: 100,
			},
			{
				opinionId: 20,
				type: "040dissent",
				plainText: "I respectfully dissent from the majority holding on due process grounds.",
				clusterId: 100,
			},
		];

		const quote = "respectfully dissent from the majority holding";
		const result = matchQuoteAcrossOpinions(quote, opinions);

		expect(result.matchedOpinionId).toBe(20);
		expect(result.matchedOpinionType).toBe("040dissent");
		expect(result.score).toBeGreaterThanOrEqual(90);
	});
});
