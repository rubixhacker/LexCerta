import { describe, expect, it } from "vitest";
import type {
	ApiUsageOutcome,
	CitationLookupOutcome,
	CourtListenerApi,
	CourtListenerUsage,
} from "./api.js";
import type * as Budget from "./budget.js";
import { beginQuotaSync, failQuotaSync, initialCourtListenerBudgetState } from "./budget.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";
import { createCourtListenerCitationGateway } from "./gateway.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const QUERY = { volume: 347, reporter: "U.S.", page: 483, normalizedCitation: "347 U.S. 483" };
const MATCH: CitationLookupOutcome = {
	kind: "matched",
	normalizedCitation: QUERY.normalizedCitation,
	clusters: [{ id: 123, canonicalUrl: "https://www.courtlistener.com/opinion/123/brown/" }],
};
const DEFAULT_USAGE = [usage("user"), usage("citations"), usage("api_usage")];

type Script = {
	readonly admissions: readonly Budget.BudgetDecision[];
	readonly fail?: (syncToken: string) => Budget.QuotaSyncCompletion;
	readonly lookup?: CitationLookupOutcome;
	readonly start?: Budget.QuotaSyncStart;
	readonly usage?: ApiUsageOutcome;
};

function givenGateway(script: Script) {
	const events: string[] = [];
	const windows: (readonly Budget.QuotaWindow[])[] = [];
	const calls = { events, windows };
	const recorded = { kind: "recorded" as const, state: initialCourtListenerBudgetState() };
	let admission = 0;
	const coordinator: CourtListenerCoordinatorRpc = {
		async admit(input) {
			calls.events.push(`admit:${input.reservationToken}`);
			const decision = script.admissions[admission++];
			if (decision === undefined) throw new RangeError("unexpected admission");
			return decision;
		},
		async beginQuotaSync(input) {
			calls.events.push(`begin:${input.syncToken}`);
			return script.start ?? { kind: "started", state: initialCourtListenerBudgetState() };
		},
		async recordQuotaSync(input) {
			calls.events.push(`complete:${input.syncToken}`);
			calls.windows.push(input.windows);
			return recorded;
		},
		async failQuotaSync(input) {
			calls.events.push(`fail:${input.syncToken}`);
			return script.fail?.(input.syncToken) ?? recorded;
		},
		async recordQuotaSyncRateLimited(input) {
			calls.events.push(`sync-rate:${input.syncToken}`);
			return recorded;
		},
		async recordOutcome(input) {
			calls.events.push(`outcome:${input.reservationToken}`);
			return recorded;
		},
	};
	const api: CourtListenerApi = {
		async getUsage() {
			calls.events.push("usage");
			return script.usage ?? { kind: "usage", currentUsage: DEFAULT_USAGE };
		},
		async lookupCitation() {
			calls.events.push("lookup");
			return script.lookup ?? MATCH;
		},
	};
	let sequence = 0;
	return {
		calls,
		gateway: createCourtListenerCitationGateway({
			api,
			coordinator,
			now: () => NOW,
			token: () => `opaque-${++sequence}`,
		}),
	};
}

function decision(kind: Budget.BudgetDecision["kind"]): Budget.BudgetDecision {
	const state = initialCourtListenerBudgetState();
	switch (kind) {
		case "reserved":
			return { kind, state, token: "data-1" };
		case "quota_limited":
		case "circuit_open":
		case "sync_unavailable":
			return { kind, state, retryAt: new Date(NOW.getTime() + 60_000) };
		case "quota_exhausted":
			return { kind, state, retryAt: null };
		case "sync_required":
		case "sync_in_progress":
		case "probe_in_flight":
		case "reservation_conflict":
		case "reservation_capacity_exhausted":
			return { kind, state };
	}
}

function usage(scope: string): CourtListenerUsage {
	return {
		scope,
		rate: "minute",
		used: 1,
		limit: 5,
		remaining: 4,
		windowSeconds: 60,
		resetAt: null,
		blocked: false,
	};
}

function quota(scope: string, remaining = 4): Budget.QuotaWindow {
	return { limit: 5, rate: "minute", remaining, resetAt: null, scope, windowSeconds: 60 };
}

describe("CourtListener citation gateway", () => {
	it("reserves and consumes quota sync before one citation reservation", async () => {
		// Given: first-use quota requires a usage synchronization and then permits citation data.
		const { calls, gateway } = givenGateway({
			admissions: [decision("sync_required"), decision("reserved")],
		});

		// When: a supported citation is verified.
		const observation = await gateway.lookup(QUERY);

		// Then: the quota-sync and data tokens each correlate to exactly one HTTP attempt and completion.
		expect(observation.kind).toBe("verified");
		expect(calls.events).toEqual([
			"admit:opaque-1",
			"begin:opaque-2",
			"usage",
			"complete:opaque-2",
			"admit:opaque-3",
			"lookup",
			"outcome:data-1",
		]);
		expect(
			calls.windows[0]?.map((window) => [window.scope, window.limit, window.windowSeconds]),
		).toEqual([
			["user", 5, 60],
			["citations", 5, 60],
			["api_usage", 5, 60],
		]);
	});

	it("fails closed when live usage omits api_usage", async () => {
		// Given: required citation rows lack the quota that authorizes the sync GET itself.
		let state: Budget.CourtListenerBudgetState = {
			...initialCourtListenerBudgetState(),
			quota: {
				kind: "confirmed",
				value: {
					confirmedAt: new Date(0),
					windows: [quota("user"), quota("citations"), quota("api_usage", 1)],
				},
			},
		};
		const start = beginQuotaSync({ now: NOW, state, syncToken: "opaque-2" });
		if (start.kind !== "started") throw new RangeError("expected quota sync reservation");
		state = start.state;
		const { calls, gateway } = givenGateway({
			admissions: [decision("sync_required")],
			fail(syncToken) {
				const completion = failQuotaSync({ now: NOW, state, syncToken });
				state = completion.state;
				return completion;
			},
			usage: { kind: "usage", currentUsage: [usage("user"), usage("citations")] },
		});

		// When: the gateway attempts its initial quota synchronization.
		const observation = await gateway.lookup(QUERY);

		// Then: it consumes the lease as failed and never admits or fetches citation data.
		expect(observation).toEqual({ kind: "indeterminate", reason: "quota_unknown" });
		expect(calls.events).toEqual(["admit:opaque-1", "begin:opaque-2", "usage", "fail:opaque-2"]);
		const prior = state.quota.kind === "sync_backoff" ? state.quota.prior : null;
		expect(prior?.windows.map((window) => [window.scope, window.remaining])).toEqual([
			["user", 4],
			["citations", 4],
			["api_usage", 0],
		]);
	});

	it("reconciles one unexpected data rate limit without retrying citation data", async () => {
		// Given: an admitted citation POST receives a 429 and reconciliation usage succeeds.
		const { calls, gateway } = givenGateway({
			admissions: [decision("reserved")],
			lookup: { kind: "rate_limited", retryAfterSeconds: 11 },
		});

		// When: the citation lookup is performed.
		const observation = await gateway.lookup(QUERY);

		// Then: its outcome precedes one reserved usage refresh and there is no second data POST.
		expect(observation).toEqual({
			kind: "indeterminate",
			reason: "rate_limited",
			retryAfterSeconds: 11,
		});
		expect(calls.events).toEqual([
			"admit:opaque-1",
			"lookup",
			"outcome:data-1",
			"begin:opaque-2",
			"usage",
			"complete:opaque-2",
		]);
	});

	it("records a usage 429 with a conservative retry and no data fetch", async () => {
		// Given: the initial admitted quota-sync GET is rate-limited without Retry-After.
		const { calls, gateway } = givenGateway({
			admissions: [decision("sync_required")],
			usage: { kind: "rate_limited" },
		});

		// When: the citation requires quota synchronization.
		const observation = await gateway.lookup(QUERY);

		// Then: the sync lease becomes rate-limited for fifteen minutes rather than generic backoff or a POST.
		expect(observation).toEqual({
			kind: "indeterminate",
			reason: "rate_limited",
			retryAfterSeconds: 900,
		});
		expect(calls.events).toEqual([
			"admit:opaque-1",
			"begin:opaque-2",
			"usage",
			"sync-rate:opaque-2",
		]);
	});

	it("does not start a second usage fetch while reconciliation is in progress", async () => {
		// Given: another invocation owns the quota-sync reservation after a data 429.
		const { calls, gateway } = givenGateway({
			admissions: [decision("reserved")],
			lookup: { kind: "rate_limited", retryAfterSeconds: 11 },
			start: { kind: "already_in_progress", state: initialCourtListenerBudgetState() },
		});

		// When: this invocation reconciles its completed citation reservation.
		await gateway.lookup(QUERY);

		// Then: it neither storms usage nor retries the citation POST.
		expect(calls.events).toEqual(["admit:opaque-1", "lookup", "outcome:data-1", "begin:opaque-2"]);
	});

	it.each([
		{ kind: "reservation_capacity_exhausted", state: initialCourtListenerBudgetState() },
		{ kind: "quota_sync_quota_exhausted", retryAt: null, state: initialCourtListenerBudgetState() },
	] as const)("does not fetch when quota synchronization is denied", async (start) => {
		// Given: a data admission requires sync but quota-sync capacity is unavailable.
		const { calls, gateway } = givenGateway({
			admissions: [decision("sync_required")],
			start,
		});

		// When: verification is requested.
		const observation = await gateway.lookup(QUERY);

		// Then: no usage or citation request occurs.
		expect(observation).toEqual({ kind: "indeterminate", reason: "quota_unknown" });
		expect(calls.events).toEqual(["admit:opaque-1", "begin:opaque-2"]);
	});

	it.each([
		[
			{ kind: "absent", normalizedCitation: QUERY.normalizedCitation },
			{ kind: "not_found", retrievedAt: NOW.toISOString() },
		],
		[
			{ kind: "ambiguous", normalizedCitations: [QUERY.normalizedCitation] },
			{ kind: "indeterminate", reason: "incomplete" },
		],
		[
			{ kind: "unavailable", failure: "timeout" },
			{ kind: "indeterminate", reason: "timeout" },
		],
	] as const)("maps source outcome %# conservatively", async (lookup, expected) => {
		// Given: a reserved one-attempt source classification.
		const { gateway } = givenGateway({ admissions: [decision("reserved")], lookup });

		// When: the gateway translates it to the verification contract.
		expect(await gateway.lookup(QUERY)).toEqual(expected);
	});
});
