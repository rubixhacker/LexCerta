import { describe, expect, it } from "vitest";
import { verifyQuoteInputSchema } from "./quote-contract.js";

describe("verifyQuoteInputSchema", () => {
	it("measures citation and quote bounds by Unicode code points", () => {
		// Given: boundary values made of supplementary Unicode characters.
		const character = "é";

		// When: parsing each schema-boundary request.
		const results = [
			verifyQuoteInputSchema.safeParse({
				citation: character.repeat(256),
				quote: character.repeat(20),
			}),
			verifyQuoteInputSchema.safeParse({ citation: character, quote: character.repeat(10_000) }),
			verifyQuoteInputSchema.safeParse({ citation: "", quote: character.repeat(20) }),
			verifyQuoteInputSchema.safeParse({
				citation: character.repeat(257),
				quote: character.repeat(20),
			}),
			verifyQuoteInputSchema.safeParse({ citation: character, quote: character.repeat(19) }),
			verifyQuoteInputSchema.safeParse({ citation: character, quote: character.repeat(10_001) }),
		];

		// Then: both inclusive Unicode bounds are accepted and adjacent values are rejected.
		expect(results.map((result) => result.success)).toEqual([
			true,
			true,
			false,
			false,
			false,
			false,
		]);
	});
});
