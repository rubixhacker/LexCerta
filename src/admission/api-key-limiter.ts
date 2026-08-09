import { DurableObject } from "cloudflare:workers";
import type { ApiKeyLimits } from "../admin/key-lifecycle.js";
import { admitRollingWindow } from "./rolling-window.js";

const USAGE_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;

export type ApiKeyLimiterAdmission = {
	readonly admittedAt: number;
	readonly limits: ApiKeyLimits;
};

export type ApiKeyLimiterResult =
	| { readonly kind: "allowed" }
	| { readonly kind: "exhausted"; readonly retryAfterSeconds: number };

type AdmissionRow = { readonly admitted_at: number };
type OldestAdmissionRow = { readonly admitted_at: number | null };

export class ApiKeyLimiter extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS api_key_admissions (admitted_at INTEGER NOT NULL)",
			);
			this.ctx.storage.sql.exec(
				"CREATE INDEX IF NOT EXISTS api_key_admissions_admitted_at_idx ON api_key_admissions(admitted_at)",
			);
		});
	}

	async admit(input: ApiKeyLimiterAdmission): Promise<ApiKeyLimiterResult> {
		const result = this.ctx.storage.transactionSync<ApiKeyLimiterResult>(() => {
			this.deleteExpiredUsage(input.admittedAt);
			const decision = admitRollingWindow({
				admissions: this.readDayAdmissions(input.admittedAt),
				clock: { now: () => new Date(input.admittedAt) },
				limits: input.limits,
			});

			switch (decision.kind) {
				case "allowed":
					this.ctx.storage.sql.exec(
						"INSERT INTO api_key_admissions (admitted_at) VALUES (?1)",
						input.admittedAt,
					);
					return { kind: "allowed" };
				case "exhausted":
					return {
						kind: "exhausted",
						retryAfterSeconds: decision.retryAfterSeconds,
					};
				default: {
					const unreachable: never = decision;
					return unreachable;
				}
			}
		});
		await this.scheduleUsageExpiry();
		return result;
	}

	async alarm(): Promise<void> {
		this.ctx.storage.transactionSync(() => {
			this.deleteExpiredUsage(Date.now());
		});
		await this.scheduleUsageExpiry();
	}

	private deleteExpiredUsage(now: number): void {
		this.ctx.storage.sql.exec(
			"DELETE FROM api_key_admissions WHERE admitted_at <= ?1",
			now - USAGE_RETENTION_MILLISECONDS,
		);
	}

	private readDayAdmissions(now: number): readonly Date[] {
		const rows = this.ctx.storage.sql
			.exec<AdmissionRow>(
				"SELECT admitted_at FROM api_key_admissions WHERE admitted_at > ?1 ORDER BY admitted_at",
				now - USAGE_RETENTION_MILLISECONDS,
			)
			.toArray();
		return rows.map((row) => new Date(row.admitted_at));
	}

	private async scheduleUsageExpiry(): Promise<void> {
		const row = this.ctx.storage.sql
			.exec<OldestAdmissionRow>("SELECT MIN(admitted_at) AS admitted_at FROM api_key_admissions")
			.one();
		if (row.admitted_at === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(row.admitted_at + USAGE_RETENTION_MILLISECONDS);
	}
}
