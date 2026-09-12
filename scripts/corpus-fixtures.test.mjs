import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";

// This validates frozen source evidence without opening the product holdout.
const root = new URL("../operations/qualification/corpus-2026-09-12/", import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
const manifest = await json("frozen/manifest.json");
const annotations = await json("annotations.json");
const raw = gunzipSync(await readFile(new URL("frozen/cases.jsonl.gz", root)), {
	maxOutputLength: 8 * 1024 * 1024,
});
const cases = raw.toString("utf8").trimEnd().split("\n").map(JSON.parse);
const sha = (value) => createHash("sha256").update(value).digest("hex");

// Independent plaintext oracle for source annotations, not a product call. The
// real-source envelopes will use plain_text; entity spellings stay literal.
const punctuation = new Map([
	...[..."‘’‚‛"].map((character) => [character, "'"]),
	...[..."“”„‟"].map((character) => [character, '"']),
	...[..."‐‑‒–—―−"].map((character) => [character, "-"]),
]);
function sourceText(value) {
	const normalized = [...value.normalize("NFC")]
		.map((character) => punctuation.get(character) ?? character)
		.join("");
	return normalized
		.split(/[\t\n\v\f\r \u00a0]+/)
		.join(" ")
		.trim();
}

test("frozen case identities, source bytes, and holdout match the pre-tuning tracker anchor", () => {
	// Issue 34 comment 5648381977 fixes this hash before any product replay.
	assert.equal(sha(raw), "8375df8bb49c95b4cbc7090e375359165c0a2079dd20171d033e5b73ccdf8faa");
	assert.equal(manifest.uncompressedSha256, sha(raw));
	assert.equal(annotations.sourceArchiveUncompressedSha256, sha(raw));
	assert.equal(manifest.uncompressedBytes, raw.length);
	assert.equal(cases.length, 60);
	assert.equal(new Set(cases.map((item) => item.id)).size, 60);
	assert.equal(cases.filter((item) => item.split === "holdout").length, 20);
	for (const stratum of ["scotus", "federal", "state"]) {
		assert.equal(cases.filter((item) => item.stratum === stratum).length, 20);
	}
	for (const attribute of ["ocr", "multipleOpinions", "post2018", "over64KiB"]) {
		assert.ok(cases.filter((item) => item.attributes[attribute]).length >= 10);
	}
	for (const item of cases) {
		const metadata = manifest.cases.find((record) => record.id === item.id);
		const { opinions, ...rest } = item;
		assert.deepEqual(metadata, {
			...rest,
			opinions: opinions.map(({ text: _text, ...opinion }) => opinion),
		});
		for (const opinion of opinions) {
			assert.equal(Buffer.byteLength(opinion.text), opinion.utf8Bytes);
			assert.equal(sha(opinion.text), opinion.sha256);
		}
	}
});

test("every reviewed exact fragment is anchored to immutable source bytes", () => {
	assert.equal(annotations.cases.length, 60);
	assert.deepEqual(
		annotations.cases.map((item) => item.clusterId),
		cases.map((item) => item.id),
	);
	for (const annotation of annotations.cases) {
		const item = cases.find((item) => item.id === annotation.clusterId);
		const opinion = item.opinions.find((opinion) => opinion.id === annotation.sourceOpinionId);
		assert.equal(annotation.sourceOpinionSha256, opinion.sha256);
		assert.equal(annotation.split, item.split);
		assert.equal(annotation.citation, item.citation);
		assert.equal(annotation.citationEvidence.currentCourtListenerLookupObserved, false);
		assert.equal(
			Buffer.from(opinion.text)
				.subarray(annotation.sourceUtf8Start, annotation.sourceUtf8End)
				.toString("utf8"),
			annotation.exactQuote,
		);
		assert.deepEqual(
			annotation.completeOpinionIds,
			item.opinions.map((opinion) => opinion.id),
		);
		assert.ok(annotation.matchingOpinionIds.includes(opinion.id));
		assert.notEqual(annotation.exactQuote, annotation.alteredQuote);
		assert.equal(
			annotation.exactQuote.replace(annotation.alteration.before, annotation.alteration.after),
			annotation.alteredQuote,
		);
		assert.equal(annotation.alteration.occurrence, 1);
	}
});

test("all reviewed alterations remain absent across the complete frozen source texts", () => {
	for (const annotation of annotations.cases) {
		const item = cases.find((item) => item.id === annotation.clusterId);
		const normalized = item.opinions.map((opinion) => ({
			id: opinion.id,
			text: sourceText(opinion.text),
		}));
		assert.deepEqual(
			normalized
				.filter((opinion) => opinion.text.includes(sourceText(annotation.exactQuote)))
				.map((opinion) => opinion.id),
			annotation.matchingOpinionIds,
		);
		assert.ok(
			normalized.every((opinion) => !opinion.text.includes(sourceText(annotation.alteredQuote))),
			`Altered fragment present in cluster ${item.id}`,
		);
	}
});
