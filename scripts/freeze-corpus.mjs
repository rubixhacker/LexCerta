import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

// Offline selection only. This program never imports or runs LexCerta verification.
const [inputDirectory, outputDirectory] = process.argv.slice(2);
if (!inputDirectory || !outputDirectory) {
	throw new Error(
		"Usage: node scripts/freeze-corpus.mjs CAPTURED_INPUT_DIRECTORY NEW_OUTPUT_DIRECTORY",
	);
}
const lock = JSON.parse(
	await readFile(
		new URL("../operations/qualification/corpus-2026-09-12/inputs.lock.json", import.meta.url),
	),
);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const attributes = ["ocr", "multipleOpinions", "post2018", "over64KiB"];
const canonicalReporters = new Set([
	"U.S.",
	"S. Ct.",
	"L. Ed.",
	"L. Ed. 2d",
	"F.",
	"F.2d",
	"F.3d",
	"F.4th",
	"F. Supp.",
	"F. Supp. 2d",
	"F. Supp. 3d",
	"A.",
	"A.2d",
	"A.3d",
	"N.E.",
	"N.E.2d",
	"N.E.3d",
	"N.W.",
	"N.W.2d",
	"P.",
	"P.2d",
	"P.3d",
	"S.E.",
	"S.E.2d",
	"S.W.",
	"S.W.2d",
	"S.W.3d",
	"So.",
	"So. 2d",
	"So. 3d",
]);
const excludedTrialCourts = new Set([
	"New York Court of Chancery",
	"Connecticut Superior Court",
	"Superior Court of Delaware",
	"Vermont Superior Court",
]);
function stratum(row) {
	if (row.court_full_name === "Supreme Court of the United States") return "scotus";
	if (row.court_type === "F" && /^Court of Appeals for the .+ Circuit$/.test(row.court_full_name))
		return "federal";
	if (row.court_type === "FD" && row.court_full_name.startsWith("District Court, "))
		return "federal";
	if (["S", "SA"].includes(row.court_type) && !excludedTrialCourts.has(row.court_full_name))
		return "state";
	return undefined;
}
function supportedCitation(citations, court) {
	const supported = (citations ?? []).filter((citation) => {
		const match = /^(\d+) (.+) (\d+)$/.exec(citation);
		return (
			match && Number(match[1]) > 0 && Number(match[3]) > 0 && canonicalReporters.has(match[2])
		);
	});
	return court === "scotus"
		? (supported.find((citation) => /^\d+ U\.S\. \d+$/.test(citation)) ?? supported[0])
		: supported[0];
}
const candidates = [];
const audit = [];
const seen = new Set();
for (const source of lock.sources) {
	const body = await readFile(resolve(inputDirectory, source.file));
	if (body.length !== source.bytes || sha(body) !== source.sha256)
		throw new Error(`Changed input: ${source.file}`);
	const rows =
		source.format === "jsonl"
			? body
					.toString("utf8")
					.trimEnd()
					.split("\n")
					.map((line, index) => ({ row: JSON.parse(line), row_idx: index, truncated_cells: [] }))
			: JSON.parse(body).rows;
	for (const { row, row_idx: index, truncated_cells: truncated } of rows) {
		const origin = { file: source.file, row: index };
		const reasons = [];
		const court = stratum(row);
		const citation = supportedCitation(row.citations, court);
		const opinions = row.opinions ?? [];
		const sizes = opinions.map((opinion) => Buffer.byteLength(opinion.opinion_text ?? "", "utf8"));
		if (seen.has(row.id)) reasons.push("duplicate_cluster_first_input_retained");
		if (truncated.length) reasons.push("viewer_truncated_cells");
		if (!court) reasons.push("outside_declared_court_strata");
		if (!citation) reasons.push("no_supported_reporter_citation");
		if (!Number.isSafeInteger(row.id) || row.id <= 0) reasons.push("invalid_cluster_id");
		if (!opinions.length || opinions.some((opinion) => !opinion.opinion_text?.trim()))
			reasons.push("missing_opinion_text");
		if (
			opinions.some(
				(opinion) => !Number.isSafeInteger(opinion.opinion_id) || opinion.opinion_id <= 0,
			)
		)
			reasons.push("invalid_opinion_id");
		if (new Set(opinions.map((opinion) => opinion.opinion_id)).size !== opinions.length)
			reasons.push("duplicate_opinion_id");
		if (Math.max(0, ...sizes) < 2_000) reasons.push("no_substantive_text_at_least_2000_utf8_bytes");
		audit.push({ id: row.id, source: origin, reasons });
		seen.add(row.id);
		if (reasons.length) continue;
		candidates.push({
			id: row.id,
			name: row.case_name,
			dateFiled: row.date_filed,
			court: row.court_full_name,
			stratum: court,
			citation,
			citations: row.citations,
			canonicalUrl: `https://www.courtlistener.com/opinion/${row.id}/${row.slug}/`,
			source: origin,
			attributes: {
				ocr: opinions.some((opinion) => opinion.ocr === true),
				multipleOpinions: opinions.length > 1,
				post2018: row.date_filed >= "2019-01-01",
				over64KiB: sizes.some((size) => size > 65_536),
			},
			opinions: opinions.map((opinion, index) => ({
				id: opinion.opinion_id,
				type: opinion.type,
				ocr: opinion.ocr,
				utf8Bytes: sizes[index],
				sha256: sha(opinion.opinion_text),
				text: opinion.opinion_text,
			})),
		});
	}
}
function counts(cases) {
	return {
		strata: Object.fromEntries(
			["scotus", "federal", "state"].map((court) => [
				court,
				cases.filter((item) => item.stratum === court).length,
			]),
		),
		attributes: Object.fromEntries(
			attributes.map((attribute) => [
				attribute,
				cases.filter((item) => item.attributes[attribute]).length,
			]),
		),
	};
}
function select(pool, capacities, minimum, seed) {
	const selected = [];
	const total = Object.values(capacities).reduce((a, b) => a + b, 0);
	while (selected.length < total) {
		const current = counts(selected);
		const remaining = pool.filter(
			(item) => !selected.includes(item) && current.strata[item.stratum] < capacities[item.stratum],
		);
		const score = (item) =>
			attributes.reduce(
				(value, attribute) =>
					value + (current.attributes[attribute] < minimum && item.attributes[attribute] ? 1 : 0),
				0,
			);
		remaining.sort(
			(a, b) => score(b) - score(a) || sha(`${seed}:${a.id}`).localeCompare(sha(`${seed}:${b.id}`)),
		);
		if (!remaining.length) throw new Error("Insufficient candidates for fixed strata");
		selected.push(remaining[0]);
	}
	const actual = counts(selected);
	if (attributes.some((attribute) => actual.attributes[attribute] < minimum))
		throw new Error(`Unsatisfied overlap minima: ${JSON.stringify(actual)}`);
	return selected;
}
const selected = select(candidates, { scotus: 20, federal: 20, state: 20 }, 10, lock.selectionSeed);
const holdout = select(
	selected,
	{ scotus: 6, federal: 7, state: 7 },
	3,
	`${lock.selectionSeed}:holdout`,
);
const selectedIds = new Set(selected.map((item) => item.id));
const holdoutIds = new Set(holdout.map((item) => item.id));
const cases = selected
	.sort((a, b) => a.id - b.id)
	.map((item) => ({ ...item, split: holdoutIds.has(item.id) ? "holdout" : "development" }));
for (const record of audit) {
	if (!record.reasons.length)
		record.disposition = selectedIds.has(record.id)
			? "selected"
			: "eligible_not_selected_by_seeded_strata";
}
const metadata = cases.map(({ opinions, ...item }) => ({
	...item,
	opinions: opinions.map(({ text: _text, ...opinion }) => opinion),
}));
const texts = Buffer.from(`${cases.map((item) => JSON.stringify(item)).join("\n")}\n`);
const frozen = {
	version: 1,
	selectionSeed: lock.selectionSeed,
	implementationBeforeFreeze: lock.implementationBeforeFreeze,
	counts: counts(cases),
	holdoutCounts: counts(holdout),
	eligibleCandidates: candidates.length,
	consideredRows: audit.length,
	textArchive: "cases.jsonl.gz",
	uncompressedSha256: sha(texts),
	uncompressedBytes: texts.length,
	cases: metadata,
};
await mkdir(resolve(outputDirectory), { recursive: false });
await writeFile(
	resolve(outputDirectory, "manifest.json"),
	`${JSON.stringify(frozen, null, "\t")}\n`,
	{ flag: "wx" },
);
await writeFile(
	resolve(outputDirectory, "selection-audit.jsonl"),
	`${audit.map((record) => JSON.stringify(record)).join("\n")}\n`,
	{ flag: "wx" },
);
await writeFile(resolve(outputDirectory, "cases.jsonl.gz"), gzipSync(texts, { level: 9 }), {
	flag: "wx",
});
console.log(
	JSON.stringify({
		counts: frozen.counts,
		holdout: frozen.holdoutCounts,
		candidates: candidates.length,
		archiveBytes: texts.length,
	}),
);
