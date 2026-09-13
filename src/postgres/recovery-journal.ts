import { createHash } from "node:crypto";
import { z } from "zod";

const PublicId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const Instant = z.iso.datetime({ precision: 3 });
export const RecoveryRestriction = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("revoke_key"), publicId: PublicId }),
	z.strictObject({ kind: z.literal("expire_key"), publicId: PublicId, notAfter: Instant }),
	z.strictObject({
		kind: z.literal("remove_opinion"),
		opinionId: z.number().int().positive().safe(),
	}),
]);
export type RecoveryRestriction = z.infer<typeof RecoveryRestriction>;
export const RecoveryRecord = z.strictObject({
	version: z.literal(1),
	environment: z.enum(["staging", "production"]),
	restriction: RecoveryRestriction,
});
export type RecoveryRecord = z.infer<typeof RecoveryRecord>;
export const MAX_RECOVERY_RECORD_BYTES = 1024;

export class RecoveryJournalUnavailable extends Error {
	constructor() {
		super("recovery journal unavailable; mutation outcome unknown");
	}
}

export type RecoveryObject = {
	readonly key: string;
	readonly generation: string;
	readonly createdAt: string;
};

export interface RecoveryJournalWriter {
	readonly environment: RecoveryRecord["environment"];
	append(restriction: RecoveryRestriction, signal?: AbortSignal): Promise<RecoveryObject>;
}

export interface RecoveryJournalReader {
	list(
		pageToken?: string,
		signal?: AbortSignal,
	): Promise<{
		readonly objects: readonly RecoveryObject[];
		readonly nextPageToken: string | null;
	}>;
	read(object: RecoveryObject, signal?: AbortSignal): Promise<RecoveryRecord>;
}

// Strict parsing reconstructs field order and rejects arbitrary metadata. Records
// contain restrictions only: replay cannot issue a key or remove a restriction.
export function encodeRecoveryRecord(value: RecoveryRecord): { key: string; bytes: Buffer } {
	const record = RecoveryRecord.parse(value);
	const bytes = Buffer.from(JSON.stringify(record));
	if (bytes.length > MAX_RECOVERY_RECORD_BYTES) throw new RecoveryJournalUnavailable();
	const hash = createHash("sha256").update(bytes).digest("hex");
	return { key: `restrictions/v1/${record.environment}/${hash}.json`, bytes };
}

export function decodeRecoveryRecord(
	bytes: Uint8Array,
	key: string,
	environment: RecoveryRecord["environment"],
): RecoveryRecord {
	try {
		if (bytes.length > MAX_RECOVERY_RECORD_BYTES) throw new RecoveryJournalUnavailable();
		const record = RecoveryRecord.parse(
			JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
		);
		const canonical = encodeRecoveryRecord(record);
		if (
			record.environment !== environment ||
			canonical.key !== key ||
			!canonical.bytes.equals(bytes)
		)
			throw new RecoveryJournalUnavailable();
		return record;
	} catch {
		throw new RecoveryJournalUnavailable();
	}
}
