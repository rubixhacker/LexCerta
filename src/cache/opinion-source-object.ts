import type { OpinionSourceObservation } from "../verification/opinion-source-cache.js";
import {
	OpinionSourceCacheCorruptError,
	parseOpinionSourceVersion,
} from "./opinion-source-record.js";
import type { OpinionSourceWriteObservation } from "./opinion-source-store.js";

export type PreparedOpinionSourceObject = {
	readonly observation: OpinionSourceObservation;
	readonly uploadedObjectKey: string | undefined;
};

export async function prepareOpinionSourceObject(input: {
	readonly bucket: R2Bucket;
	readonly database: D1Database;
	readonly ownerToken: string;
	readonly observation: OpinionSourceWriteObservation;
}): Promise<PreparedOpinionSourceObject> {
	if (input.observation.kind === "negative") {
		return { observation: input.observation, uploadedObjectKey: undefined };
	}
	const calculatedHash = await contentHash(input.observation.sourceText);
	const existing = await versionFor(
		input.database,
		input.observation.provenance.opinionId,
		calculatedHash,
	);
	if (existing !== null) {
		const object = await input.bucket.get(existing.objectKey);
		const { contentHash: storedContentHash } = object?.customMetadata ?? {};
		if (
			existing.metadata.provenance.canonicalUrl !== input.observation.provenance.canonicalUrl ||
			existing.metadata.provenance.clusterId !== input.observation.provenance.clusterId ||
			object === null ||
			storedContentHash !== calculatedHash ||
			(await contentHash(await object.text())) !== calculatedHash
		)
			throw new OpinionSourceCacheCorruptError();
		return {
			observation: {
				kind: "positive",
				provenance: input.observation.provenance,
				representation: input.observation.representation,
				contentHash: calculatedHash,
				objectKey: existing.objectKey,
			},
			uploadedObjectKey: undefined,
		};
	}
	const ownerHash = await contentHash(input.ownerToken);
	const objectKey = `opinions/${input.observation.provenance.opinionId}/${hashHex(calculatedHash)}/${hashHex(ownerHash)}`;
	await input.bucket.put(objectKey, input.observation.sourceText, {
		customMetadata: { contentHash: calculatedHash },
		httpMetadata: { contentType: "text/plain; charset=utf-8" },
	});
	return {
		observation: {
			kind: "positive",
			provenance: input.observation.provenance,
			representation: input.observation.representation,
			contentHash: calculatedHash,
			objectKey,
		},
		uploadedObjectKey: objectKey,
	};
}

export async function deleteStagedOpinionSourceObject(
	bucket: R2Bucket,
	prepared: PreparedOpinionSourceObject,
): Promise<void> {
	if (prepared.uploadedObjectKey !== undefined) await bucket.delete(prepared.uploadedObjectKey);
}

export async function contentHash(value: string): Promise<string> {
	const hash = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
	return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function versionFor(
	database: D1Database,
	opinionId: number,
	contentHash: string,
): Promise<{
	readonly metadata: Extract<OpinionSourceObservation, { readonly kind: "positive" }>;
	readonly objectKey: string;
} | null> {
	const row = await database
		.prepare(
			"SELECT object_key, metadata_json, representation FROM opinion_source_object_versions WHERE opinion_id = ?1 AND content_sha256_hex = ?2",
		)
		.bind(opinionId, hashHex(contentHash))
		.first<unknown>();
	if (row === null) return null;
	const version = parseOpinionSourceVersion(row);
	if (version.metadata.contentHash !== contentHash) throw new OpinionSourceCacheCorruptError();
	return { metadata: version.metadata, objectKey: version.objectKey };
}

function hashHex(value: string): string {
	return value.slice("sha256:".length);
}
