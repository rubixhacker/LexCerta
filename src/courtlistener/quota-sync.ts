import type { CourtListenerApi, CourtListenerUsage } from "./api.js";
import type { QuotaWindow } from "./budget.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";

const FALLBACK_RETRY_SECONDS = 15 * 60;

export type CourtListenerQuotaSyncResult =
	| { readonly kind: "failed" | "ready" }
	| { readonly kind: "rate_limited"; readonly retryAt: Date };

export type CourtListenerQuotaSyncOptions = {
	readonly api: Pick<CourtListenerApi, "getUsage">;
	readonly coordinator: CourtListenerCoordinatorRpc;
	readonly now: () => Date;
	readonly token: () => string;
};

export async function synchronizeCourtListenerQuota(
	options: CourtListenerQuotaSyncOptions,
): Promise<CourtListenerQuotaSyncResult> {
	const syncToken = options.token();
	const started = await value(() =>
		options.coordinator.beginQuotaSync({ now: options.now(), syncToken }),
	);
	if (started?.kind !== "started") return { kind: "failed" };
	const usage = await value(() => options.api.getUsage());
	if (usage?.kind === "usage") {
		const windows = quotaWindows(usage.currentUsage);
		if (windows !== null) {
			const completed = await value(() =>
				options.coordinator.recordQuotaSync({ now: options.now(), syncToken, windows }),
			);
			return completed?.kind === "recorded" ? { kind: "ready" } : { kind: "failed" };
		}
	} else if (usage?.kind === "rate_limited") {
		const now = options.now();
		const retryAt = new Date(
			now.getTime() + (usage.retryAfterSeconds ?? FALLBACK_RETRY_SECONDS) * 1_000,
		);
		const recorded = await value(() =>
			options.coordinator.recordQuotaSyncRateLimited({ now, retryAt, syncToken }),
		);
		return recorded?.kind === "recorded" ? { kind: "rate_limited", retryAt } : { kind: "failed" };
	}
	await value(() => options.coordinator.failQuotaSync({ now: options.now(), syncToken }));
	return { kind: "failed" };
}

function quotaWindows(usage: readonly CourtListenerUsage[]): readonly QuotaWindow[] | null {
	const windows = usage.flatMap((row) => {
		if (row.scope !== "user" && row.scope !== "citations" && row.scope !== "api_usage") return [];
		const resetAt = row.resetAt === null ? null : new Date(row.resetAt);
		if (resetAt !== null && Number.isNaN(resetAt.getTime())) return [];
		return [
			{
				limit: row.limit,
				rate: row.rate,
				remaining: row.blocked ? 0 : row.remaining,
				resetAt,
				scope: row.scope,
				windowSeconds: row.windowSeconds,
			},
		];
	});
	return windows.some((window) => window.scope === "user") &&
		windows.some((window) => window.scope === "citations") &&
		windows.some((window) => window.scope === "api_usage")
		? windows
		: null;
}

function value<Value>(call: () => Promise<Value>): Promise<Value | undefined> {
	return call().catch((error: unknown) => {
		if (error instanceof Error) return undefined;
		throw error;
	});
}
