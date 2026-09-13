import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PgTransaction, TransactionDatabase } from "./database.js";

const Owner = z.object({
	epoch: z.string().regex(/^\d+$/),
	owner_token: z.string().uuid().nullable(),
	lease_expires_at: z.date().nullable(),
	created_at: z.date(),
});
const Stage = z.enum(["retention", "citations", "opinions", "objects", "orphans"]);
const Progress = z.object({
	name: z.enum(["cleanup", "lifecycle"]),
	scheduled_for: z.date().nullable(),
	completed_for: z.date().nullable(),
	completed_at: z.date().nullable(),
	stage: Stage,
	citation_cursor: z.string().min(1).max(256).nullable(),
	opinion_cursor: z
		.string()
		.regex(/^[1-9]\d{0,18}$/)
		.nullable(),
	orphan_page_token: z.string().min(1).max(8192).nullable(),
	orphan_after_key: z.string().min(1).max(1024).nullable(),
	orphan_after_generation: z
		.string()
		.regex(/^[0-9]{1,32}$/)
		.nullable(),
});
export type MaintenanceProgress = z.infer<typeof Progress>;
type OwnerRow = z.infer<typeof Owner>;
type Checkpoint =
	| { readonly kind: "complete" }
	| {
			readonly kind: "stage";
			readonly stage: z.infer<typeof Stage>;
			readonly cursor?: string | null;
			readonly after?: { readonly key: string; readonly generation: string } | null;
	  };

export class MaintenanceLeaseLost extends Error {
	readonly name = "MaintenanceLeaseLost";
	constructor() {
		super("maintenance ownership unavailable");
	}
}

const OWNER_QUERY =
	"SELECT epoch, owner_token, lease_expires_at, created_at FROM lexcerta.maintenance_owner WHERE singleton = true";
const PROGRESS_QUERY =
	"SELECT name, scheduled_for, completed_for, completed_at, stage, citation_cursor, opinion_cursor, orphan_page_token, orphan_after_key, orphan_after_generation FROM lexcerta.maintenance_progress";

async function owner(transaction: PgTransaction, locked: boolean): Promise<OwnerRow> {
	const result = await transaction.query(OWNER_QUERY + (locked ? " FOR UPDATE" : ""));
	const row = Owner.safeParse(result.rows[0]);
	if (!row.success) throw new MaintenanceLeaseLost();
	return row.data;
}
async function progressRows(transaction: PgTransaction): Promise<MaintenanceProgress[]> {
	const result = await transaction.query(`${PROGRESS_QUERY} ORDER BY name`);
	const parsed = z.array(Progress).length(2).safeParse(result.rows);
	if (!parsed.success || parsed.data[0]?.name !== "cleanup" || parsed.data[1]?.name !== "lifecycle")
		throw new MaintenanceLeaseLost();
	return parsed.data;
}

function scheduledFor(name: MaintenanceProgress["name"], now: Date): Date {
	const period = name === "cleanup" ? 3_600_000 : 86_400_000;
	const offset = name === "cleanup" ? 0 : 3 * 3_600_000;
	return new Date(Math.floor((now.getTime() - offset) / period) * period + offset);
}
function due(progress: MaintenanceProgress, now: Date): boolean {
	if (
		(progress.scheduled_for && progress.scheduled_for > now) ||
		(progress.completed_for && progress.completed_for > now)
	)
		throw new MaintenanceLeaseLost();
	return (
		progress.scheduled_for !== null ||
		progress.completed_for === null ||
		progress.completed_for < scheduledFor(progress.name, now)
	);
}

export async function claimMaintenance(database: TransactionDatabase) {
	return database.transaction(async (transaction) => {
		const row = await owner(transaction, true);
		const now = await transaction.now();
		if (row.owner_token !== null && row.lease_expires_at !== null && row.lease_expires_at > now)
			return { kind: "busy" as const };
		if (!(await progressRows(transaction)).some((progress) => due(progress, now)))
			return { kind: "idle" as const };
		const token = randomUUID();
		const result = await transaction.query<{ epoch: string }>(
			"UPDATE lexcerta.maintenance_owner SET epoch = epoch + 1, owner_token = $1, lease_expires_at = $2, started_at = $3, finished_at = NULL, outcome = 'running' WHERE singleton = true RETURNING epoch",
			[token, new Date(now.getTime() + 90_000), now],
		);
		const epoch = result.rows[0]?.epoch;
		if (epoch === undefined) throw new MaintenanceLeaseLost();
		return { kind: "acquired" as const, lease: new MaintenanceLease(database, token, epoch) };
	});
}

// Each wrapped transaction locks and verifies the job fence before and after
// its SQL. Object I/O is outside this wrapper and still uses generation checks.
export class MaintenanceLease {
	readonly database: TransactionDatabase;
	constructor(
		private readonly underlying: TransactionDatabase,
		private readonly token: string,
		private readonly epoch: string,
	) {
		this.database = {
			transaction: <T>(operation: (transaction: PgTransaction) => Promise<T>) =>
				underlying.transaction(async (transaction) => {
					await this.verify(transaction);
					const result = await operation(transaction);
					await this.verify(transaction);
					return result;
				}),
		};
	}
	private async verify(transaction: PgTransaction): Promise<void> {
		const row = await owner(transaction, true);
		const now = await transaction.now();
		if (
			row.owner_token !== this.token ||
			row.epoch !== this.epoch ||
			row.lease_expires_at === null ||
			row.lease_expires_at <= now
		)
			throw new MaintenanceLeaseLost();
	}
	async renew(): Promise<void> {
		await this.database.transaction(async (transaction) => {
			const now = await transaction.now();
			await transaction.query(
				"UPDATE lexcerta.maintenance_owner SET lease_expires_at = $1 WHERE singleton = true",
				[new Date(now.getTime() + 90_000)],
			);
		});
	}
	async next(): Promise<MaintenanceProgress | null> {
		return this.database.transaction(async (transaction) => {
			const now = await transaction.now();
			for (const row of await progressRows(transaction)) {
				if (!due(row, now)) continue;
				if (row.scheduled_for !== null) return row;
				const slot = scheduledFor(row.name, now);
				await transaction.query(
					"UPDATE lexcerta.maintenance_progress SET scheduled_for = $2 WHERE name = $1",
					[row.name, slot],
				);
				return { ...row, scheduled_for: slot };
			}
			return null;
		});
	}
	async checkpoint(expected: MaintenanceProgress, next: Checkpoint): Promise<void> {
		await this.database.transaction(async (transaction) => {
			const current = (await progressRows(transaction)).find((row) => row.name === expected.name);
			if (expected.scheduled_for === null || !isDeepStrictEqual(current, expected))
				throw new MaintenanceLeaseLost();
			if (next.kind === "complete") {
				if (expected.name !== "cleanup" && expected.stage !== "orphans")
					throw new MaintenanceLeaseLost();
				await transaction.query(
					"UPDATE lexcerta.maintenance_progress SET completed_for = scheduled_for, completed_at = clock_timestamp(), scheduled_for = NULL, stage = 'retention', citation_cursor = NULL, opinion_cursor = NULL, orphan_page_token = NULL, orphan_after_key = NULL, orphan_after_generation = NULL WHERE name = $1",
					[expected.name],
				);
				return;
			}
			const stages = Stage.options;
			if (
				expected.name !== "lifecycle" ||
				![stages.indexOf(expected.stage), stages.indexOf(expected.stage) + 1].includes(
					stages.indexOf(next.stage),
				)
			)
				throw new MaintenanceLeaseLost();
			const changed = Progress.parse({
				...expected,
				stage: next.stage,
				citation_cursor: next.stage === "citations" ? (next.cursor ?? null) : null,
				opinion_cursor: next.stage === "opinions" ? (next.cursor ?? null) : null,
				orphan_page_token: next.stage === "orphans" ? (next.cursor ?? null) : null,
				orphan_after_key: next.stage === "orphans" ? (next.after?.key ?? null) : null,
				orphan_after_generation: next.stage === "orphans" ? (next.after?.generation ?? null) : null,
			});
			await transaction.query(
				"UPDATE lexcerta.maintenance_progress SET stage = $2, citation_cursor = $3, opinion_cursor = $4, orphan_page_token = $5, orphan_after_key = $6, orphan_after_generation = $7 WHERE name = $1",
				[
					changed.name,
					changed.stage,
					changed.citation_cursor,
					changed.opinion_cursor,
					changed.orphan_page_token,
					changed.orphan_after_key,
					changed.orphan_after_generation,
				],
			);
		});
	}
	async release(outcome: "complete" | "partial" | "failed"): Promise<void> {
		await this.underlying.transaction(async (transaction) => {
			await this.verify(transaction);
			if (outcome === "complete") {
				const now = await transaction.now();
				if ((await progressRows(transaction)).some((row) => due(row, now)))
					throw new MaintenanceLeaseLost();
			}
			await transaction.query(
				"UPDATE lexcerta.maintenance_owner SET owner_token = NULL, lease_expires_at = NULL, finished_at = clock_timestamp(), outcome = $1 WHERE singleton = true",
				[outcome],
			);
		});
	}
}

export async function readMaintenanceHealth(database: TransactionDatabase) {
	return database.transaction(async (transaction) => {
		const origin = await owner(transaction, false);
		const now = await transaction.now();
		const result: Record<string, { completedAt: string | null; overdue: boolean }> = {};
		for (const row of await progressRows(transaction)) {
			due(row, now); // Invalid future progress cannot establish a healthy heartbeat.
			const threshold = row.name === "cleanup" ? 2 * 3_600_000 : 26 * 3_600_000;
			result[row.name] = {
				completedAt: row.completed_at?.toISOString() ?? null,
				overdue: now.getTime() - (row.completed_for ?? origin.created_at).getTime() >= threshold,
			};
		}
		return result;
	});
}
