import { describe, expect, it } from "vitest";
import type {
	ApiUsageOutcome,
	CitationLookupOutcome,
	CourtListenerApi,
	CourtListenerUsage,
} from "./api.js";
import type { BudgetDecision, CourtListenerOutcome, QuotaWindow } from "./budget.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";
import { createCourtListenerCitationGateway } from "./gateway.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const QUERY = { volume: 347, reporter: "U.S.", page: 483, normalizedCitation: "347 U.S. 483" };
const MATCHED: CitationLookupOutcome = {
	kind: "matched",
	normalizedCitation: QUERY.normalizedCitation,
	clusters: [{ id: 123, canonicalUrl: "https://www.courtlistener.com/opinion/123/brown/" }],
};

type Script = {
	readonly admissions: readonly BudgetDecision[];
	readonly lookup?: CitationLookupOutcome;
	readonly usage?: ApiUsageOutcome;
};

function givenGateway(script: Script) {
	const outcomes: CourtListenerOutcome[] = [];
	const quotaWindows: (readonly QuotaWindow[])[] = [];
	const calls = {
		admit: 0,
		getUsage: 0,
		lookup: 0,
		recordOutcome: outcomes,
		recordQuotaSync: quotaWindows,
		failQuotaSync: 0,
	};
	let admission = 0;
	const coordinator: CourtListenerCoordinatorRpc = {
		async admit() {
			calls.admit += 1;
			const decision = script.admissions[admission++];
			if (decision === undefined) throw new RangeError("unexpected admission");
			return decision;
		},
		async beginQuotaSync() {
			return { kind: "started", state: STATE };
		},
		async recordQuotaSync(input) {
			calls.recordQuotaSync.push(input.windows);
			return { kind: "recorded", state: STATE };
		},
		async failQuotaSync() {
			calls.failQuotaSync += 1;
			return { kind: "recorded", state: STATE };
		},
		async recordOutcome(input) {
			calls.recordOutcome.push(input.outcome);
			return { kind: "recorded", state: STATE };
		},
	};
	const api: CourtListenerApi = {
		async getUsage() {
			calls.getUsage += 1;
			return script.usage ?? { kind: "usage", currentUsage: [] };
		},
		async lookupCitation() {
			calls.lookup += 1;
			return script.lookup ?? MATCHED;
		},
	};
	let token = 0;
	return {
		calls,
		gateway: createCourtListenerCitationGateway({
			api,
			coordinator,
			now: () => NOW,
			token: () => `opaque-${++token}`,
		}),
	};
}

const STATE = {
	circuits: {
		case_law: { kind: "closed", consecutiveFailures: 0 },
		citation: { kind: "closed", consecutiveFailures: 0 },
	},
	pendingReservations: [],
	quota: { kind: "unknown" },
} as const;

function decision(kind: BudgetDecision["kind"]): BudgetDecision {
	switch (kind) {
		case "reserved":
			return { kind, state: STATE, token: "reserved" };
		case "quota_limited":
			return { kind, state: STATE, retryAt: new Date(NOW.getTime() + 60_000) };
		case "circuit_open":
			return { kind, state: STATE, retryAt: new Date(NOW.getTime() + 30_000) };
		case "sync_required":
		case "sync_in_progress":
			return { kind, state: STATE };
		case "quota_exhausted":
			return { kind, state: STATE, retryAt: null };
		case "probe_in_flight":
			return { kind, state: STATE };
		case "reservation_conflict":
			return { kind, state: STATE };
		case "sync_unavailable":
			return { kind, state: STATE, retryAt: new Date(NOW.getTime() + 60_000) };
	}
}

function usage(scope: string, resetAt: string | null = null): CourtListenerUsage {
	return {
		scope,
		rate: "minute",
		used: 1,
		limit: 5,
		remaining: 4,
		windowSeconds: 60,
		resetAt,
		blocked: false,
	};
}

describe("CourtListener citation gateway", () => {
	it("returns verified metadata after one reserved citation attempt", async () => {
		// Given: the coordinator grants one citation reservation and the source returns one trusted cluster.
		const { calls, gateway } = givenGateway({ admissions: [decision("reserved")] });

		// When: a normalized supported citation is verified.
		const observation = await gateway.lookup(QUERY);

		// Then: one request is recorded once and no opaque coordinator token enters the observation.
		expect(observation).toEqual({
			kind: "verified",
			cluster: MATCHED.clusters[0],
			retrievedAt: NOW.toISOString(),
		});
		expect(calls.lookup).toBe(1);
		expect(calls.recordOutcome).toEqual([{ kind: "success" }]);
		expect(JSON.stringify(observation)).not.toContain("opaque-");
	});

	it("synchronizes user and citation capacity before one retry admission", async () => {
		// Given: stale capacity requires synchronization and the usage endpoint supplies both required scopes.
		const { calls, gateway } = givenGateway({
			admissions: [decision("sync_required"), decision("reserved")],
			usage: {
				kind: "usage",
				currentUsage: [
					usage("user", "2026-08-09T12:01:00.000Z"),
					usage("citations"),
					usage("api_usage"),
				],
			},
		});

		// When: the gateway performs its first verification with unknown quota.
		const observation = await gateway.lookup(QUERY);

		// Then: it makes one usage attempt, records only required windows, and retries admission once before lookup.
		expect(observation.kind).toBe("verified");
		expect(calls.getUsage).toBe(1);
		expect(calls.admit).toBe(2);
		expect(calls.recordQuotaSync[0]).toMatchObject([
			{ scope: "user", limit: 5, windowSeconds: 60 },
			{ scope: "citations", limit: 5, windowSeconds: 60 },
		]);
		expect(calls.lookup).toBe(1);
	});

	it.each([
		["a concurrent usage sync", decision("sync_in_progress"), "quota_unknown"],
		["quota backoff", decision("sync_unavailable"), "quota_unknown"],
		["exhausted quota", decision("quota_exhausted"), "quota_unknown"],
		["an open citation circuit", decision("circuit_open"), "circuit_open"],
		["a half-open probe", decision("probe_in_flight"), "quota_unknown"],
	] as const)("does not fetch data during %s", async (_name, admission, reason) => {
		// Given: the coordinator cannot reserve a citation attempt.
		const { calls, gateway } = givenGateway({ admissions: [admission] });

		// When: verification is requested.
		const observation = await gateway.lookup(QUERY);

		// Then: the result is sanitized and neither usage nor citation data is fetched.
		expect(observation).toMatchObject({ kind: "indeterminate", reason });
		expect(calls.getUsage).toBe(0);
		expect(calls.lookup).toBe(0);
	});

	it("fails a malformed quota sync without a citation request", async () => {
		// Given: initial synchronization lacks a required citation window.
		const { calls, gateway } = givenGateway({
			admissions: [decision("sync_required")],
			usage: {
				kind: "usage",
				currentUsage: [usage("user")],
			},
		});

		// When: a citation needs capacity.
		const observation = await gateway.lookup(QUERY);

		// Then: quota stays fail-closed and the lookup is never sent.
		expect(observation).toEqual({ kind: "indeterminate", reason: "quota_unknown" });
		expect(calls.failQuotaSync).toBe(1);
		expect(calls.lookup).toBe(0);
	});

	it("records a rate limit once and preserves only retry guidance", async () => {
		// Given: one reservation receives an upstream 429 with a bounded retry deadline.
		const { calls, gateway } = givenGateway({
			admissions: [decision("reserved")],
			lookup: { kind: "rate_limited", retryAfterSeconds: 11 },
		});

		// When: the citation is looked up.
		const observation = await gateway.lookup(QUERY);

		// Then: one rate-limit outcome is recorded and no response body or token is returned.
		expect(observation).toEqual({
			kind: "indeterminate",
			reason: "rate_limited",
			retryAfterSeconds: 11,
		});
		expect(calls.recordOutcome).toEqual([
			{ kind: "rate_limited", retryAt: new Date(NOW.getTime() + 11_000) },
		]);
	});

	it.each([
		[
			{ kind: "absent", normalizedCitation: QUERY.normalizedCitation },
			{ kind: "not_found", retrievedAt: NOW.toISOString() },
		],
		[
			{ kind: "ambiguous", normalizedCitations: ["347 U.S. 483"] },
			{ kind: "indeterminate", reason: "incomplete" },
		],
		[
			{ kind: "unknown_reporter", normalizedCitation: QUERY.normalizedCitation },
			{ kind: "indeterminate", reason: "incomplete" },
		],
		[
			{ kind: "item_cap", normalizedCitation: QUERY.normalizedCitation },
			{ kind: "indeterminate", reason: "incomplete" },
		],
		[{ kind: "malformed_response" }, { kind: "indeterminate", reason: "incomplete" }],
		[
			{ kind: "matched", normalizedCitation: QUERY.normalizedCitation, clusters: [] },
			{ kind: "indeterminate", reason: "incomplete" },
		],
	] as const)(
		"maps source outcome %# to the conservative observation",
		async (lookup, expected) => {
			// Given: a reserved attempt with a non-success source classification.
			const { gateway } = givenGateway({ admissions: [decision("reserved")], lookup });

			// When: the source result is translated for citation verification.
			const observation = await gateway.lookup(QUERY);

			// Then: only explicit source absence becomes not_found.
			expect(observation).toEqual(expected);
		},
	);

	it.each([
		[{ kind: "unavailable", failure: "timeout" }, { kind: "timeout" }, "timeout"],
		[
			{ kind: "unavailable", failure: "server", status: 503 },
			{ kind: "server_error" },
			"upstream_unavailable",
		],
		[
			{ kind: "unavailable", failure: "transport" },
			{ kind: "transport_error" },
			"upstream_unavailable",
		],
	] as const)("records %# without retrying", async (lookup, outcome, reason) => {
		// Given: a reserved upstream failure.
		const { calls, gateway } = givenGateway({ admissions: [decision("reserved")], lookup });

		// When: the source cannot complete the single attempt.
		const observation = await gateway.lookup(QUERY);

		// Then: the circuit receives its classified outcome exactly once.
		expect(observation).toEqual({ kind: "indeterminate", reason });
		expect(calls.recordOutcome[0]).toEqual(outcome);
	});
});
