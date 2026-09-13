import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PgDatabase, PgTransaction } from "./database.js";
import { withMigrationConnection } from "./migration-connection.js";
import type {
	RecoveryJournalReader,
	RecoveryRecord,
	RecoveryRestriction,
} from "./recovery-journal.js";
import { scanRecoveryJournal } from "./recovery-scan.js";
import { type DatabaseRoles, applyDatabaseGrants, validateDatabaseRoles } from "./roles.js";

export class RecoveryReplayUnavailable extends Error {
	constructor() {
		super("recovery replay unavailable; keep restored service closed");
	}
}

// Isolation is observed in PostgreSQL, not accepted as a caller's boolean.
// The coordinator must additionally isolate the provider restore and quiesce
// external journal writers. This component does not grant CONNECT or reopen.
export async function replayRecoveryJournal(options: {
	readonly database: PgDatabase;
	readonly roles: DatabaseRoles;
	readonly environment: RecoveryRecord["environment"];
	readonly actorSubject: string;
	readonly reader: RecoveryJournalReader;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}) {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeoutMs = z
			.number()
			.int()
			.min(1)
			.max(540_000)
			.parse(options.timeoutMs ?? 540_000);
		validateDatabaseRoles(options.roles, options.roles.migrator);
		z.enum(["staging", "production"]).parse(options.environment);
		z.string().min(1).max(256).parse(options.actorSubject);
		const deadline = performance.now() + timeoutMs;
		timer = setTimeout(cancel, timeoutMs);
		if (options.signal?.aborted) cancel();
		else options.signal?.addEventListener("abort", cancel, { once: true });
		const checkpoint = () => {
			if (performance.now() >= deadline) cancel();
			controller.signal.throwIfAborted();
		};
		const database = options.database.withSignal(controller.signal);
		const keyEnvironment = options.environment === "production" ? "production" : "test";
		// The restore coordinator has already removed CONNECT and drained the
		// target. Verify that before atomically sealing and revoking SQL grants.
		await database.transaction((transaction) =>
			requireIsolation(transaction, options.roles.migrator, keyEnvironment, false),
		);
		await withMigrationConnection(
			database.pool,
			options.roles.migrator,
			(client) =>
				applyDatabaseGrants(client, options.roles, { sealForRecovery: options.environment }),
			controller.signal,
		);
		const isolated = <T>(operation: (transaction: PgTransaction) => Promise<T>) => {
			checkpoint();
			return database.transaction(async (transaction) => {
				await requireIsolation(transaction, options.roles.migrator, keyEnvironment, true);
				const control = await transaction.query<{ environment: string | null }>(
					"SELECT environment FROM lexcerta.recovery_control WHERE singleton FOR UPDATE",
				);
				if (
					control.rowCount !== 1 ||
					(control.rows[0]?.environment !== null &&
						control.rows[0]?.environment !== options.environment)
				)
					throw new RecoveryReplayUnavailable();
				await transaction.query(
					"UPDATE lexcerta.recovery_control SET sealed_at = coalesce(sealed_at, clock_timestamp()), environment = $1 WHERE singleton",
					[options.environment],
				);
				const result = await operation(transaction);
				checkpoint();
				return result;
			});
		};
		// Seal before any external I/O. A failed scan leaves the target sealed.
		await isolated(async () => undefined);
		checkpoint();
		const scan = await scanRecoveryJournal(options.reader, options.environment, {
			signal: controller.signal,
			bounds: { timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) },
		});
		await isolated(async (transaction) => {
			await transaction.query(
				"INSERT INTO lexcerta.recovery_runs(inventory_sha256, environment, record_count) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
				[scan.inventorySha256, scan.environment, scan.entries.length],
			);
		});
		let complete = false;
		while (!complete) {
			complete = await isolated(async (transaction) => {
				const run = (
					await transaction.query<{
						environment: string;
						record_count: number;
						next_index: number;
					}>("SELECT * FROM lexcerta.recovery_runs WHERE inventory_sha256 = $1 FOR UPDATE", [
						scan.inventorySha256,
					])
				).rows[0];
				if (
					!run ||
					run.environment !== scan.environment ||
					run.record_count !== scan.entries.length
				)
					throw new RecoveryReplayUnavailable();
				const end = Math.min(run.next_index + 10, scan.entries.length);
				for (const { object, record } of scan.entries.slice(run.next_index, end)) {
					const encoded = JSON.stringify(record);
					const receipt = await transaction.query<{ matches: boolean }>(
						"SELECT generation = $2 AND object_created_at = $3 AND record = $4::jsonb AS matches FROM lexcerta.recovery_receipts WHERE object_key = $1",
						[object.key, object.generation, object.createdAt, encoded],
					);
					if (receipt.rowCount !== 0) {
						if (receipt.rows[0]?.matches !== true) throw new RecoveryReplayUnavailable();
						continue;
					}
					if (record.restriction.kind === "remove_opinion")
						await transaction.query("SELECT * FROM lexcerta.remove_opinion($1,$2,$3)", [
							record.restriction.opinionId,
							options.actorSubject,
							keyEnvironment,
						]);
					else
						await applyKeyRestriction(
							transaction,
							record.restriction,
							keyEnvironment,
							options.actorSubject,
							object.key,
						);
					await transaction.query(
						"INSERT INTO lexcerta.recovery_receipts(object_key, generation, object_created_at, record) VALUES ($1,$2,$3,$4::jsonb)",
						[object.key, object.generation, object.createdAt, encoded],
					);
				}
				const finished = end === scan.entries.length;
				await transaction.query(
					"UPDATE lexcerta.recovery_runs SET next_index = $2, completed_at = CASE WHEN $3 THEN coalesce(completed_at, clock_timestamp()) ELSE NULL END WHERE inventory_sha256 = $1",
					[scan.inventorySha256, end, finished],
				);
				return finished;
			});
		}
		checkpoint();
		return {
			outcome: "restrictions_replayed" as const,
			inventorySha256: scan.inventorySha256,
			records: scan.entries.length,
			databaseSealed: true as const,
		};
	} catch {
		throw new RecoveryReplayUnavailable();
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
		cancel();
	}
}

async function requireIsolation(
	transaction: PgTransaction,
	expectedMigrator: string,
	keyEnvironment: "production" | "test",
	requireSealedGrants: boolean,
) {
	const lock = await transaction.query<{ acquired: boolean }>(
		"SELECT pg_try_advisory_xact_lock(746237100) AS acquired",
	);
	if (lock.rows[0]?.acquired !== true) throw new RecoveryReplayUnavailable();
	const result = await transaction.query<{ isolated: boolean }>(
		`
		SELECT current_user = $1 AND session_user = current_user
			AND d.datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
			AND NOT EXISTS (
				SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'MEMBER')
				AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
					OR r.rolbypassrls OR r.rolname = 'neon_superuser')
			)
			AND NOT EXISTS (
				SELECT 1 FROM aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
				WHERE a.privilege_type = 'CONNECT' AND a.grantee <> d.datdba
			)
			AND NOT EXISTS (
				SELECT 1 FROM pg_stat_activity a WHERE a.datid = d.oid
				AND a.pid <> pg_backend_pid()
			)
			AND NOT EXISTS (SELECT 1 FROM lexcerta.api_keys WHERE environment <> $2)
			AND (NOT $3 OR NOT EXISTS (
				SELECT 1 FROM (
					SELECT n.nspacl AS acl, n.nspowner AS owner FROM pg_namespace n WHERE n.nspname = 'lexcerta'
					UNION ALL SELECT c.relacl, c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'lexcerta'
					UNION ALL SELECT a.attacl, c.relowner FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'lexcerta'
					UNION ALL SELECT coalesce(p.proacl, acldefault('f', p.proowner)), p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'lexcerta'
				) grants CROSS JOIN LATERAL aclexplode(grants.acl) a WHERE a.grantee <> grants.owner
			)) AS isolated
		FROM pg_database d WHERE d.datname = current_database()
	`,
		[expectedMigrator, keyEnvironment, requireSealedGrants],
	);
	if (result.rows[0]?.isolated !== true) throw new RecoveryReplayUnavailable();
}

async function applyKeyRestriction(
	transaction: PgTransaction,
	restriction: Exclude<RecoveryRestriction, { kind: "remove_opinion" }>,
	environment: "production" | "test",
	actor: string,
	objectKey: string,
) {
	const rule = (
		await transaction.query<{ revoked: boolean; not_after: Date | null }>(
			`INSERT INTO lexcerta.recovered_key_restrictions(public_id, environment, revoked, not_after)
			VALUES ($1,$2,$3,$4) ON CONFLICT (public_id, environment) DO UPDATE SET
			revoked = lexcerta.recovered_key_restrictions.revoked OR excluded.revoked,
			not_after = CASE
				WHEN excluded.not_after IS NULL THEN lexcerta.recovered_key_restrictions.not_after
				WHEN lexcerta.recovered_key_restrictions.not_after IS NULL THEN excluded.not_after
				ELSE least(lexcerta.recovered_key_restrictions.not_after, excluded.not_after) END
			RETURNING revoked, not_after`,
			[
				restriction.publicId,
				environment,
				restriction.kind === "revoke_key",
				restriction.kind === "expire_key" ? restriction.notAfter : null,
			],
		)
	).rows[0];
	if (!rule) throw new RecoveryReplayUnavailable();
	await transaction.query(
		"SELECT public_id FROM lexcerta.api_key_admission_locks WHERE public_id = $1 FOR UPDATE",
		[restriction.publicId],
	);
	const key = (
		await transaction.query<{
			customer_id: string;
			status: string;
			issued_at: Date;
			expires_at: Date;
		}>("SELECT * FROM lexcerta.api_keys WHERE public_id = $1 AND environment = $2 FOR UPDATE", [
			restriction.publicId,
			environment,
		])
	).rows[0];
	if (!key || key.status === "revoked") return;
	const revoke = rule.revoked || (rule.not_after !== null && rule.not_after <= key.issued_at);
	if (revoke)
		await transaction.query(
			"WITH event_time AS MATERIALIZED (SELECT clock_timestamp() AS now) UPDATE lexcerta.api_keys SET status = 'revoked', revoked_at = event_time.now, rotation_overlap_until = NULL, retention_expires_at = event_time.now + interval '1 year' FROM event_time WHERE public_id = $1",
			[restriction.publicId],
		);
	else if (rule.not_after !== null && rule.not_after < key.expires_at)
		await transaction.query(
			"UPDATE lexcerta.api_keys SET expires_at = $2, rotation_overlap_until = CASE WHEN rotation_overlap_until IS NULL THEN NULL ELSE least(rotation_overlap_until, $2) END, retention_expires_at = $2::timestamptz + interval '1 year' WHERE public_id = $1",
			[restriction.publicId, rule.not_after],
		);
	else return;
	await transaction.query(
		"WITH event_time AS MATERIALIZED (SELECT clock_timestamp() AS now) INSERT INTO lexcerta.admin_audit_events(id, action, actor_subject, customer_id, public_id, environment, occurred_at, retention_expires_at, metadata) SELECT $1,'key_recovery_restricted',$2,$3,$4,$5,event_time.now,event_time.now + interval '1 year',$6::jsonb FROM event_time",
		[
			randomUUID(),
			actor,
			key.customer_id,
			restriction.publicId,
			environment,
			JSON.stringify({ recoveryObject: objectKey }),
		],
	);
}
