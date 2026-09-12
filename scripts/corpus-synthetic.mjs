// These intentionally invented records test contracts, not real-world coverage.
// Expected labels were authored from the source/failure scenarios before replay.
const text = "Equal justice under law applies to every person.";
const other = "Different language appears in this opinion without the requested words.";
const definition = (id, expected, quote, fields, extra = {}) => ({
	id,
	expected,
	quote,
	fields,
	...extra,
});
const cases = [
	definition("positive-nfc", "verified", "Café is the name used throughout this opinion.", {
		plain_text: "Cafe\u0301 is the name used throughout this opinion.",
	}),
	definition("positive-quotes", "verified", 'The court wrote "equal justice" in its opinion.', {
		plain_text: "The court wrote “equal justice” in its opinion.",
	}),
	definition("positive-dashes", "verified", "The words equal-justice appear in this text.", {
		plain_text: "The words equal—justice appear in this text.",
	}),
	definition("positive-html", "verified", "Equal & fair justice under law.", {
		html: "<p>Equal &amp; fair</p><p>justice under law.</p>",
	}),
	definition("positive-precedence", "verified", text, {
		html_with_citations: `<p>${text}</p>`,
		html: other,
		plain_text: other,
	}),
	definition(
		"positive-parallel-spelling",
		"verified",
		text,
		{ plain_text: text },
		{ inputCitation: "123 US 6" },
	),
	definition(
		"positive-dissent",
		"verified",
		text,
		{ plain_text: other },
		{ secondFields: { plain_text: text }, matchingIndex: 1 },
	),
	definition(
		"positive-early-match",
		"verified",
		text,
		{ plain_text: text },
		{ secondFields: { plain_text: other }, matchingIndex: 0 },
	),
	definition("negative-case", "not_found", text.toLowerCase(), { plain_text: text }),
	definition("negative-word", "not_found", text.replace("every", "some"), { plain_text: text }),
	definition("negative-ellipsis", "not_found", "Equal justice ... applies to every person.", {
		plain_text: text,
	}),
	definition(
		"negative-brackets",
		"not_found",
		"Equal justice under law applies to [each] person.",
		{ plain_text: text },
	),
	definition("negative-script", "not_found", text, {
		html: `<script>${text}</script><p>${other}</p>`,
	}),
	definition("negative-precedence", "not_found", text, {
		html_with_citations: `<p>${other}</p>`,
		plain_text: text,
	}),
	definition("negative-inline-space", "not_found", "Alpha beta is the exact requested wording.", {
		html: "<p>Alpha<span>beta</span> is the exact requested wording.</p>",
	}),
	definition(
		"negative-all-opinions",
		"not_found",
		text,
		{ plain_text: other },
		{ secondFields: { plain_text: "A dissent with entirely different language." } },
	),
	...[
		"Id. at 5",
		"42 U.S.C. § 1983",
		"2024 WL 12345",
		"2024 LEXIS 123",
		"Smith, supra",
		"2024 TX 100",
	].map((citation, index) =>
		definition(
			`unsupported-${index + 1}`,
			"indeterminate",
			text,
			{},
			{ inputCitation: citation, reason: "unsupported_citation", category: "unsupported" },
		),
	),
	...["ambiguous-status", "ambiguous-clusters", "ambiguous-normalization"].map((mode) =>
		definition(
			mode,
			"indeterminate",
			text,
			{},
			{ mode, reason: "incomplete", category: "ambiguous" },
		),
	),
	definition(
		"empty-fields",
		"indeterminate",
		text,
		{},
		{ category: "empty", reason: "incomplete" },
	),
	definition(
		"empty-whitespace",
		"indeterminate",
		text,
		{ plain_text: " \n\t " },
		{ category: "empty", reason: "incomplete" },
	),
	definition(
		"unsupported-field",
		"indeterminate",
		text,
		{ xml_harvard: `<opinion>${text}</opinion>` },
		{ category: "empty", reason: "incomplete" },
	),
	...["oversized", "truncated-json", "invalid-utf8"].map((mode) =>
		definition(
			mode,
			"indeterminate",
			text,
			{},
			{ mode, category: "oversized-or-truncated", reason: "incomplete" },
		),
	),
	...[
		["partial-missing", "incomplete"],
		["partial-server", "upstream_unavailable"],
		["partial-transport", "upstream_unavailable"],
	].map(([mode, reason]) =>
		definition(
			mode,
			"indeterminate",
			text,
			{ plain_text: other },
			{ mode, reason, category: "partial", secondFields: { plain_text: other } },
		),
	),
	definition(
		"quota-unknown",
		"indeterminate",
		text,
		{},
		{ mode: "quota-unknown", category: "quota", reason: "quota_unknown" },
	),
	definition(
		"quota-rate-limited",
		"indeterminate",
		text,
		{},
		{ mode: "quota-rate-limited", category: "quota", reason: "rate_limited" },
	),
	definition(
		"stale-negative-citation",
		"indeterminate",
		text,
		{},
		{ mode: "stale-negative-citation", category: "stale-negative", reason: "upstream_unavailable" },
	),
	definition(
		"stale-negative-opinion",
		"indeterminate",
		text,
		{},
		{ mode: "stale-negative-opinion", category: "stale-negative", reason: "upstream_unavailable" },
	),
	definition(
		"reversal-citation",
		"indeterminate",
		text,
		{},
		{ mode: "reversal-citation", category: "reversal", reason: "source_changed" },
	),
	definition(
		"reversal-opinion",
		"indeterminate",
		text,
		{},
		{ mode: "reversal-opinion", category: "reversal", reason: "source_changed" },
	),
];

export const syntheticVectors = cases.map((item, index) => {
	const clusterId = 90_000_000 + index;
	return {
		...item,
		kind: "synthetic",
		category: item.category ?? item.expected,
		citation: `123 U.S. ${index + 1}`,
		inputCitation: item.inputCitation ?? `123 U.S. ${index + 1}`,
		clusterId,
		canonicalUrl: `https://www.courtlistener.com/opinion/${clusterId}/synthetic-fixture/`,
		opinions: [item.fields, ...(item.secondFields ? [item.secondFields] : [])].map((fields, i) => ({
			id: 91_000_000 + index * 10 + i,
			fields,
		})),
	};
});
