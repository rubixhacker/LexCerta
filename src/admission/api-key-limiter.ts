import { DurableObject } from "cloudflare:workers";
import { type ApiKeyLimits, MAXIMUM_API_KEY_LIMITS } from "../admin/key-lifecycle.js";
import { admitRollingWindow } from "./rolling-window.js";

const USAGE_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const BUCKET_RETENTION_MILLISECONDS = 48 * 60 * 60 * 1_000;

export type ApiKeyLimiterAdmission = {
	readonly admittedAt: number;
	readonly publicId: string;
};

export type ApiKeyLimiterResult =
	| { readonly kind: "allowed" }
	| { readonly kind: "exhausted"; readonly retryAfterSeconds: number };

type AdmissionRow = { readonly admitted_at: number };
type StoredLimitConfig = {
	readonly day_limit: number;
	readonly limits_version: number;
	readonly minute_limit: number;
};

type CanonicalLimitConfig = {
	readonly limits: ApiKeyLimits;
	readonly limitsVersion: number;
};

export class ApiKeyLimitConfigurationError extends Error {
	readonly name = "ApiKeyLimitConfigurationError";

	constructor(readonly limitsVersion: number) {
		super(`conflicting API key limits for version ${limitsVersion}`);
	}
}

export class ApiKeyLimitRecordError extends Error {
	readonly name = "ApiKeyLimitRecordError";
}

export class ApiKeyLimiterIdentityError extends Error {
	readonly name = "ApiKeyLimiterIdentityError";

	constructor() {
		super("Durable Object name does not match the API key public identifier");
	}
}

export class ApiKeyLimiter extends DurableObject {
	private readonly database: D1Database;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.database = env.DB;
		this.ctx.blockConcurrencyWhile(async () => {
			this.ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS api_key_admissions (admitted_at INTEGER NOT NULL)",
			);
			this.ctx.storage.sql.exec(
				"CREATE INDEX IF NOT EXISTS api_key_admissions_admitted_at_idx ON api_key_admissions(admitted_at)",
			);
			this.ctx.storage.sql.exec(
				"CREATE TABLE IF NOT EXISTS api_key_limit_config (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), limits_version INTEGER NOT NULL, minute_limit INTEGER NOT NULL, day_limit INTEGER NOT NULL)",
			);
		});
	}

	async admit(input: ApiKeyLimiterAdmission): Promise<ApiKeyLimiterResult> {
		if (this.ctx.id.name !== input.publicId) throw new ApiKeyLimiterIdentityError();
		const canonicalLimits = await this.readCanonicalLimits(input.publicId);
		const result = this.ctx.storage.transactionSync<ApiKeyLimiterResult>(() => {
			const limits = this.selectLimits(canonicalLimits);
			this.deleteExpiredUsage(input.admittedAt);
			const decision = admitRollingWindow({
				admissions: this.readDayAdmissions(input.admittedAt),
				clock: { now: () => new Date(input.admittedAt) },
				limits,
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
		if (result.kind === "allowed") await this.scheduleUsageExpiry();
		return result;
	}

	async alarm(): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM api_key_admissions");
	}

	private deleteExpiredUsage(now: number): void {
		this.ctx.storage.sql.exec(
			"DELETE FROM api_key_admissions WHERE admitted_at <= ?1",
			now - USAGE_RETENTION_MILLISECONDS,
		);
	}

	private async scheduleUsageExpiry(): Promise<void> {
		const newest = this.ctx.storage.sql
			.exec<{ readonly admitted_at: number | null }>(
				"SELECT MAX(admitted_at) AS admitted_at FROM api_key_admissions",
			)
			.one().admitted_at;
		if (newest === null) return;
		const expiresAt = newest + BUCKET_RETENTION_MILLISECONDS;
		const alarm = await this.ctx.storage.getAlarm();
		if (alarm === null || alarm < expiresAt) await this.ctx.storage.setAlarm(expiresAt);
	}

	private async readCanonicalLimits(publicId: string): Promise<CanonicalLimitConfig> {
		try {
			const raw = await this.database
				.prepare(
					"SELECT minute_limit, day_limit, limits_version FROM api_key_records WHERE public_id = ?1 LIMIT 1",
				)
				.bind(publicId)
				.first<unknown>();
			return parseCanonicalLimitConfig(raw);
		} catch (error) {
			if (error instanceof ApiKeyLimitRecordError) throw error;
			throw new ApiKeyLimitRecordError("canonical API key limit lookup unavailable", {
				cause: error,
			});
		}
	}

	private selectLimits(input: CanonicalLimitConfig): ApiKeyLimits {
		const stored = this.ctx.storage.sql
			.exec<StoredLimitConfig>(
				"SELECT limits_version, minute_limit, day_limit FROM api_key_limit_config WHERE singleton = 1",
			)
			.toArray()[0];
		if (stored === undefined) {
			this.storeLimits(input);
			return input.limits;
		}
		if (input.limitsVersion > stored.limits_version) {
			this.storeLimits(input);
			return input.limits;
		}
		if (input.limitsVersion < stored.limits_version) {
			return { minute: stored.minute_limit, day: stored.day_limit };
		}
		if (input.limits.minute !== stored.minute_limit || input.limits.day !== stored.day_limit) {
			throw new ApiKeyLimitConfigurationError(input.limitsVersion);
		}
		return input.limits;
	}

	private storeLimits(input: CanonicalLimitConfig): void {
		this.ctx.storage.sql.exec(
			"INSERT INTO api_key_limit_config (singleton, limits_version, minute_limit, day_limit) VALUES (1, ?1, ?2, ?3) ON CONFLICT(singleton) DO UPDATE SET limits_version = excluded.limits_version, minute_limit = excluded.minute_limit, day_limit = excluded.day_limit",
			input.limitsVersion,
			input.limits.minute,
			input.limits.day,
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
}

function parseCanonicalLimitConfig(value: unknown): CanonicalLimitConfig {
	if (typeof value !== "object" || value === null || !hasCanonicalLimitFields(value)) {
		throw new ApiKeyLimitRecordError("canonical API key limit record is missing or malformed");
	}
	const minute = value.minute_limit;
	const day = value.day_limit;
	const limitsVersion = value.limits_version;
	if (
		!isPositiveLimit(minute, MAXIMUM_API_KEY_LIMITS.minute) ||
		!isPositiveLimit(day, MAXIMUM_API_KEY_LIMITS.day) ||
		!isNonnegativeSafeInteger(limitsVersion)
	) {
		throw new ApiKeyLimitRecordError("canonical API key limit record is missing or malformed");
	}
	return { limits: { minute, day }, limitsVersion };
}

function hasCanonicalLimitFields(value: object): value is {
	readonly day_limit: unknown;
	readonly limits_version: unknown;
	readonly minute_limit: unknown;
} {
	return "minute_limit" in value && "day_limit" in value && "limits_version" in value;
}

function isPositiveLimit(value: unknown, maximum: number): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
