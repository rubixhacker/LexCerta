import type { QuotaSyncStart } from "./budget-contract.js";
import { recoverExpiredLeases } from "./budget-leases.js";
import {
	COURTLISTENER_LEASE_MILLISECONDS,
	MAX_PENDING_RESERVATIONS,
	QUOTA_SYNC_INTERVAL_MILLISECONDS,
	after,
} from "./budget-state.js";
import type {
	ConfirmedQuota,
	CourtListenerBudgetState,
	QuotaWindow,
	RateLimitState,
} from "./budget-state.js";

export function beginQuotaSync(input: {
	readonly now: Date;
	readonly state: CourtListenerBudgetState;
	readonly syncToken: string;
}): QuotaSyncStart {
	const state = recoverExpiredLeases(input.state, input.now);
	switch (state.quota.kind) {
		case "sync_in_progress":
			return { kind: "already_in_progress", state };
		case "unknown":
			return startQuotaSync(state, input.now, input.syncToken, null);
		case "confirmed":
			return startWhenDue(
				state,
				input.now,
				input.syncToken,
				state.quota.value,
				after(state.quota.value.confirmedAt, QUOTA_SYNC_INTERVAL_MILLISECONDS),
			);
		case "sync_backoff":
			return startWhenDue(
				state,
				input.now,
				input.syncToken,
				state.quota.prior,
				state.quota.retryAt,
			);
		case "rate_limited":
			if (state.quota.immediateSyncRequired) {
				return startQuotaSync(state, input.now, input.syncToken, state.quota.prior, {
					immediateSyncRequired: false,
					prior: state.quota.prior,
					retryAt: state.quota.retryAt,
				});
			}
			return startWhenDue(
				state,
				input.now,
				input.syncToken,
				state.quota.prior,
				state.quota.retryAt,
			);
	}
}

function startWhenDue(
	state: CourtListenerBudgetState,
	now: Date,
	token: string,
	prior: ConfirmedQuota | null,
	retryAt: Date,
): QuotaSyncStart {
	return now.getTime() < retryAt.getTime()
		? { kind: "not_due", retryAt, state }
		: startQuotaSync(state, now, token, prior);
}

function startQuotaSync(
	state: CourtListenerBudgetState,
	now: Date,
	token: string,
	prior: ConfirmedQuota | null,
	rateLimit: RateLimitState | null = null,
): QuotaSyncStart {
	if (state.pendingReservations.length >= MAX_PENDING_RESERVATIONS) {
		return { kind: "reservation_capacity_exhausted", state };
	}
	const quota = chargeApiUsage(prior, now);
	if (quota.kind === "exhausted") {
		return { kind: "quota_sync_quota_exhausted", retryAt: quota.retryAt, state };
	}
	return {
		kind: "started",
		state: {
			...state,
			pendingReservations: [
				...state.pendingReservations,
				{
					kind: "quota_sync",
					leaseExpiresAt: after(now, COURTLISTENER_LEASE_MILLISECONDS),
					token,
				},
			],
			quota: {
				kind: "sync_in_progress",
				leaseExpiresAt: after(now, COURTLISTENER_LEASE_MILLISECONDS),
				prior: quota.prior,
				rateLimit: rateLimit === null ? null : { ...rateLimit, prior: quota.prior },
				token,
			},
		},
	};
}

function chargeApiUsage(
	prior: ConfirmedQuota | null,
	now: Date,
):
	| { readonly kind: "ready"; readonly prior: ConfirmedQuota | null }
	| {
			readonly kind: "exhausted";
			readonly retryAt: Date | null;
	  } {
	if (prior === null) return { kind: "ready", prior };
	const windows = prior.windows.map((window) =>
		window.scope === "api_usage" ? normalizeWindow(window, now) : window,
	);
	const apiUsage = windows.filter((window) => window.scope === "api_usage");
	if (apiUsage.length === 0) return { kind: "exhausted", retryAt: null };
	const exhausted = apiUsage.filter((window) => window.remaining <= 0);
	if (exhausted.length > 0) return { kind: "exhausted", retryAt: latestReset(exhausted) };
	return {
		kind: "ready",
		prior: {
			...prior,
			windows: windows.map((window) =>
				window.scope === "api_usage" ? { ...window, remaining: window.remaining - 1 } : window,
			),
		},
	};
}

function normalizeWindow(window: QuotaWindow, now: Date): QuotaWindow {
	return window.resetAt !== null && window.resetAt.getTime() <= now.getTime()
		? { ...window, remaining: window.limit, resetAt: null }
		: window;
}

function latestReset(windows: readonly QuotaWindow[]): Date | null {
	const resets = windows.flatMap((window) => (window.resetAt === null ? [] : [window.resetAt]));
	return resets.length === windows.length
		? new Date(Math.max(...resets.map((reset) => reset.getTime())))
		: null;
}
