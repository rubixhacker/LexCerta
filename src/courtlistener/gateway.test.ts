import { describe, expect, it } from "vitest";
import type {
	ApiUsageOutcome,
	CitationLookupOutcome,
	CourtListenerApi,
	CourtListenerUsage,
} from "./api.js";
import type { BudgetDecision, CourtListenerOutcome, QuotaSyncStart } from "./budget.js";
import { initialCourtListenerBudgetState } from "./budget.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";
import { createCourtListenerCitationGateway } from "./gateway.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const QUERY = { volume: 347, reporter: "U.S.", page: 483, normalizedCitation: "347 U.S. 483" };
const MATCH: CitationLookupOutcome = {
	kind: "matched",
	normalizedCitation: QUERY.normalizedCitation,
	clusters: [{ id: 123, canonicalUrl: "https://www.courtlistener.com/opinion/123/brown/" }],
};

type Script = {
	readonly admissions: readonly BudgetDecision[];
	readonly lookup?: CitationLookupOutcome;
	readonly start?: QuotaSyncStart;
	readonly usage?: ApiUsageOutcome;
};

function givenGateway(script: Script) {
	const events: string[] = [];
	const outcomes: CourtListenerOutcome[] = [];
	const calls = { events, outcomes };
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
			return { kind: "recorded", state: initialCourtListenerBudgetState() };
		},
		async failQuotaSync(input) {
			calls.events.push(`fail:${input.syncToken}`);
			return { kind: "recorded", state: initialCourtListenerBudgetState() };
		},
		async recordQuotaSyncRateLimited(input) {
			calls.events.push(`sync-rate:${input.syncToken}`);
			return { kind: "recorded", state: initialCourtListenerBudgetState() };
		},
		async recordOutcome(input) {
			calls.events.push(`outcome:${input.reservationToken}`);
			calls.outcomes.push(input.outcome);
			return { kind: "recorded", state: initialCourtListenerBudgetState() };
		},
	};
	const api: CourtListenerApi = {
		async getUsage() {
			calls.events.push("usage");
			return script.usage ?? { kind: "usage", currentUsage: [usage("user"), usage("citations")] };
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

function decision(kind: BudgetDecision["kind"]): BudgetDecision {
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
		expect(calls.outcomes).toEqual([{ kind: "success" }]);
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
		expect(calls.outcomes).toEqual([
			{ kind: "rate_limited", retryAt: new Date(NOW.getTime() + 11_000) },
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

	it("does not fetch when the quota-sync reservation is denied", async () => {
		// Given: a data admission requires sync but quota-sync capacity is unavailable.
		const { calls, gateway } = givenGateway({
			admissions: [decision("sync_required")],
			start: { kind: "reservation_capacity_exhausted", state: initialCourtListenerBudgetState() },
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
