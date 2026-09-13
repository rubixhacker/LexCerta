import { randomUUID } from "node:crypto";
import { admitRollingWindow } from "../admission/rolling-window.js";
import {
	type ApiKeyPublicId,
	authenticateApiKeyRecord,
	prepareApiKeyVerification,
} from "../auth/api-key.js";
import type { PgDatabase } from "./database.js";
import { RecoveryJournalUnavailable, type RecoveryJournalWriter } from "./recovery-journal.js";

export type KeyAdmission =
	| { readonly kind: "allowed"; readonly publicId: ApiKeyPublicId }
	| {
			readonly kind: "exhausted";
			readonly publicId: ApiKeyPublicId;
			readonly retryAfterSeconds: number;
	  }
	| { readonly kind: "unauthorized" };

type KeyRow = {
	readonly public_id: string;
	readonly environment: string;
	readonly hmac_sha256_hex: string;
	readonly status: string;
	readonly expires_at: Date;
	readonly revoked_at: Date | null;
	readonly minute_limit: number;
	readonly day_limit: number;
	readonly limits_version: number;
};

export class PostgresKeyAdmission {
	constructor(
		private readonly database: PgDatabase,
		private readonly pepper: string,
		private readonly environment: string,
	) {}

	async admit(authorization: string | null): Promise<KeyAdmission> {
		const verification = await prepareApiKeyVerification(
			authorization,
			this.pepper,
			this.environment,
		);
		if (verification === null) return { kind: "unauthorized" };
		return this.database.transaction(async (transaction) => {
			const lock = await transaction.query(
				"SELECT public_id FROM lexcerta.api_key_admission_locks WHERE public_id = $1 FOR UPDATE",
				[verification.publicId],
			);
			const records = await transaction.query<KeyRow>(
				"SELECT public_id, environment, hmac_sha256_hex, status, expires_at, revoked_at, minute_limit, day_limit, limits_version FROM lexcerta.api_keys WHERE public_id = $1",
				[verification.publicId],
			);
			// Read database time after acquiring the lock, including any wait behind a revoke.
			const now = await transaction.now();
			const row = records.rows[0];
			if (row !== undefined && lock.rowCount !== 1)
				throw new Error("key admission authority unavailable");
			const auth = authenticateApiKeyRecord(
				row === undefined
					? null
					: {
							...row,
							expires_at: row.expires_at.toISOString(),
							revoked_at: row.revoked_at?.toISOString() ?? null,
						},
				verification,
				now,
			);
			if (auth.kind !== "authenticated") return { kind: "unauthorized" };
			const admissions = await transaction.query<{ admitted_at: Date }>(
				"SELECT admitted_at FROM lexcerta.key_admissions WHERE public_id = $1 AND admitted_at > $2 ORDER BY admitted_at",
				[auth.publicId, new Date(now.getTime() - 86_400_000)],
			);
			const decision = admitRollingWindow({
				admissions: admissions.rows.map((row) => row.admitted_at),
				limits: auth.limits,
				clock: { now: () => now },
			});
			if (decision.kind === "exhausted")
				return {
					kind: "exhausted",
					publicId: auth.publicId,
					retryAfterSeconds: decision.retryAfterSeconds,
				};
			await transaction.query(
				"INSERT INTO lexcerta.key_admissions(public_id, admitted_at) VALUES ($1, $2)",
				[auth.publicId, now],
			);
			return { kind: "allowed", publicId: auth.publicId };
		});
	}
}

export type StoredKeyMaterial = {
	readonly publicId: string;
	readonly customerId: string;
	readonly environment: "production" | "test";
	readonly hmacSha256Hex: string;
	readonly actorSubject: string;
	readonly minuteLimit?: number;
	readonly dayLimit?: number;
};

// Only the separate operator service receives a database identity with these
// mutations. Plaintext credentials are generated outside this store and never persisted.
export class KeyAdministrationConflict extends Error {
	constructor(message = "key unavailable") {
		super(message);
	}
}

export class PostgresKeyAdministration {
	constructor(
		private readonly database: PgDatabase,
		private readonly environment: "production" | "test",
		private readonly journal: RecoveryJournalWriter,
		private readonly signal?: AbortSignal,
	) {
		if (journal.environment !== (environment === "production" ? "production" : "staging"))
			throw new RecoveryJournalUnavailable();
	}

	async status(publicId: string) {
		return this.database.transaction(async (transaction) => {
			const result = await transaction.query<{
				customer_id: string;
				status: "active" | "revoked";
				expires_at: Date;
				minute_limit: number;
				day_limit: number;
			}>(
				"SELECT customer_id, status, expires_at, minute_limit, day_limit FROM lexcerta.api_keys WHERE public_id = $1 AND environment = $2",
				[publicId, this.environment],
			);
			const row = result.rows[0];
			return row === undefined
				? null
				: {
						publicId,
						customerId: row.customer_id,
						status: row.status,
						expiresAt: row.expires_at.toISOString(),
						limits: { minute: row.minute_limit, day: row.day_limit },
					};
		});
	}

	async issue(input: StoredKeyMaterial): Promise<{ expiresAt: Date }> {
		if (input.environment !== this.environment) throw new KeyAdministrationConflict();
		return this.database.transaction(async (transaction) => {
			const now = await transaction.now();
			await transaction.query(
				"INSERT INTO lexcerta.customers(id) VALUES ($1) ON CONFLICT (id) DO UPDATE SET retired_at = NULL, retention_expires_at = NULL",
				[input.customerId],
			);
			const expiresAt = new Date(now.getTime() + 90 * 86_400_000);
			await transaction.query(
				"INSERT INTO lexcerta.api_keys(public_id, customer_id, environment, hmac_sha256_hex, status, issued_at, expires_at, minute_limit, day_limit, retention_expires_at) VALUES ($1,$2,$3,$4,'active',$5,$6,$7,$8,$6::timestamptz + interval '1 year')",
				[
					input.publicId,
					input.customerId,
					input.environment,
					input.hmacSha256Hex,
					now,
					expiresAt,
					input.minuteLimit ?? 10,
					input.dayLimit ?? 100,
				],
			);
			await transaction.query(
				"INSERT INTO lexcerta.api_key_admission_locks(public_id) VALUES ($1)",
				[input.publicId],
			);
			await writeAudit(transaction, "key_issued", input.actorSubject, input.publicId);
			return { expiresAt };
		});
	}

	async revoke(publicId: string, actorSubject: string): Promise<void> {
		await this.database.transaction((transaction) =>
			requireKey(transaction, publicId, this.environment),
		);
		// Release the preflight lock before object I/O. An immutable restriction
		// must exist before SQL can acknowledge the mutation. A later failure may
		// leave a restriction for recovery to apply, so never report definite failure.
		try {
			await this.journal.append({ kind: "revoke_key", publicId }, this.signal);
			await this.database.transaction(async (transaction) => {
				await requireKey(transaction, publicId, this.environment);
				await transaction.query(
					"UPDATE lexcerta.api_keys SET status = 'revoked', revoked_at = clock_timestamp(), rotation_overlap_until = NULL, retention_expires_at = clock_timestamp() + interval '1 year' WHERE public_id = $1 AND status = 'active'",
					[publicId],
				);
				await writeAudit(transaction, "key_revoked", actorSubject, publicId);
			});
		} catch {
			throw new RecoveryJournalUnavailable();
		}
	}

	async changeLimits(
		publicId: string,
		actorSubject: string,
		minute: number,
		day: number,
	): Promise<void> {
		await this.database.transaction(async (transaction) => {
			await requireKey(transaction, publicId, this.environment);
			await transaction.query(
				"UPDATE lexcerta.api_keys SET minute_limit = $2, day_limit = $3, limits_version = limits_version + 1 WHERE public_id = $1",
				[publicId, minute, day],
			);
			await writeAudit(transaction, "key_limits_changed", actorSubject, publicId);
		});
	}

	async rotate(
		priorId: string,
		next: Pick<StoredKeyMaterial, "publicId" | "hmacSha256Hex" | "actorSubject">,
	): Promise<{ expiresAt: Date }> {
		const notAfter = await this.database.transaction(async (transaction) => {
			const prior = await requireKey(transaction, priorId, this.environment);
			const now = await transaction.now();
			if (prior.rotation_overlap_until !== null)
				throw new KeyAdministrationConflict("key already rotated");
			if (prior.expires_at <= now) throw new KeyAdministrationConflict();
			const existing = await transaction.query(
				"SELECT 1 FROM lexcerta.api_keys WHERE public_id = $1",
				[next.publicId],
			);
			if (existing.rowCount !== 0) throw new KeyAdministrationConflict();
			return new Date(Math.min(prior.expires_at.getTime(), now.getTime() + 7 * 86_400_000));
		});
		try {
			await this.journal.append(
				{ kind: "expire_key", publicId: priorId, notAfter: notAfter.toISOString() },
				this.signal,
			);
			return await this.database.transaction(async (transaction) => {
				const prior = await requireKey(transaction, priorId, this.environment);
				const now = await transaction.now();
				if (prior.rotation_overlap_until !== null || prior.expires_at <= now || notAfter <= now)
					throw new KeyAdministrationConflict();
				const overlap = new Date(Math.min(prior.expires_at.getTime(), notAfter.getTime()));
				const expiresAt = new Date(now.getTime() + 90 * 86_400_000);
				await transaction.query(
					"INSERT INTO lexcerta.api_keys(public_id, customer_id, environment, hmac_sha256_hex, status, issued_at, expires_at, rotation_parent_id, minute_limit, day_limit, retention_expires_at) SELECT $2, customer_id, environment, $3, 'active', $4, $5, public_id, minute_limit, day_limit, $5::timestamptz + interval '1 year' FROM lexcerta.api_keys WHERE public_id = $1",
					[priorId, next.publicId, next.hmacSha256Hex, now, expiresAt],
				);
				await transaction.query(
					"UPDATE lexcerta.api_keys SET expires_at = $2, rotation_overlap_until = $2, retention_expires_at = $2::timestamptz + interval '1 year' WHERE public_id = $1",
					[priorId, overlap],
				);
				await transaction.query(
					"INSERT INTO lexcerta.api_key_admission_locks(public_id) VALUES ($1)",
					[next.publicId],
				);
				await writeAudit(transaction, "key_rotated", next.actorSubject, next.publicId);
				return { expiresAt };
			});
		} catch {
			throw new RecoveryJournalUnavailable();
		}
	}
}

async function requireKey(
	transaction: import("./database.js").PgTransaction,
	publicId: string,
	environment: string,
) {
	const lock = await transaction.query(
		"SELECT public_id FROM lexcerta.api_key_admission_locks WHERE public_id = $1 FOR UPDATE",
		[publicId],
	);
	if (lock.rowCount !== 1) throw new KeyAdministrationConflict();
	const result = await transaction.query<{
		environment: string;
		status: string;
		expires_at: Date;
		rotation_overlap_until: Date | null;
	}>(
		"SELECT environment, status, expires_at, rotation_overlap_until FROM lexcerta.api_keys WHERE public_id = $1 FOR UPDATE",
		[publicId],
	);
	const key = result.rows[0];
	if (key === undefined || key.status !== "active" || key.environment !== environment)
		throw new KeyAdministrationConflict();
	return key;
}

async function writeAudit(
	transaction: import("./database.js").PgTransaction,
	action: string,
	actor: string,
	publicId: string,
) {
	await transaction.query(
		"INSERT INTO lexcerta.admin_audit_events(id, action, actor_subject, customer_id, public_id, environment, occurred_at, retention_expires_at) SELECT $1,$2,$3,customer_id,public_id,environment,clock_timestamp(),clock_timestamp() + interval '1 year' FROM lexcerta.api_keys WHERE public_id = $4",
		[randomUUID(), action, actor, publicId],
	);
}
