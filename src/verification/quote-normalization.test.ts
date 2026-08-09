import { describe, expect, it } from "vitest";
import { canonicalOpinionText, normalizeQuoteText, selectOpinionText } from "./quote-contract.js";

describe("normalizeQuoteText", () => {
	it("normalizes NFC, whitespace, typographic quotes, and equivalent dashes", () => {
		// Given: text that differs only by the safe-normalization forms.
		const source = "Cafe\u0301\u00a0said \u201cwell\u2014done\u201d";

		// When: normalizing source text.
		const normalized = normalizeQuoteText(source);

		// Then: it has its canonical exact-match representation.
		expect(normalized).toBe('Café said "well-done"');
	});
});

describe("canonicalOpinionText", () => {
	it("uses the HTML parser for entities, adjacent blocks, split text, and excluded elements", async () => {
		// Given: HTML that requires parser semantics rather than markup stripping.
		const selected = {
			representation: "html_with_citations" as const,
			content:
				"<p>First&nbsp;<b>part</b>&#x2014;done.</p><p>Second &quot;part&quot;.</p><script>never include</script><style>.never { display: none; }</style>",
		};

		// When: canonical text is extracted and normalized.
		const canonical = await canonicalOpinionText(selected);

		// Then: semantic text survives while markup and executable/style text do not.
		expect(canonical).toBe('First part-done. Second "part".');
	});
});

describe("safe normalization boundaries", () => {
	it("preserves case, ellipses, brackets, citations, ordering, and compatibility characters", () => {
		// Given: differences that the exact-match policy forbids normalizing.
		const source = "The Court [citation] held … ①";

		// When: the source is normalized.
		const normalized = normalizeQuoteText(source);

		// Then: those substantive distinctions remain observable.
		expect(normalized).toBe("The Court [citation] held … ①");
	});
});

describe("selectOpinionText", () => {
	it("selects html_with_citations before all fallback representations", () => {
		// Given: an opinion with three intentionally distinct representations.
		const opinion = {
			html_with_citations: "<p>preferred</p>",
			html: "<p>fallback html</p>",
			plain_text: "fallback plain text",
		};

		// When: selecting its canonical representation.
		const selected = selectOpinionText(opinion);

		// Then: the contract preserves the upstream selected field and content.
		expect(selected).toEqual({
			representation: "html_with_citations",
			content: "<p>preferred</p>",
		});
	});
});
