import { describe, expect, it } from "vitest";
import type { CourtListenerUsage } from "./api.js";
import type { BudgetDecision } from "./budget-contract.js";
import { initialCourtListenerBudgetState } from "./budget.js";
import { requestCaseLaw } from "./case-law-admission.js";
import type { CourtListenerCoordinatorRpc } from "./coordinator.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const state = initialCourtListenerBudgetState();
const usage: readonly CourtListenerUsage[] = [
	{
		blocked: false,
		limit: 10,
		rate: "minute",
		remaining: 9,
		resetAt: null,
		scope: "user",
		used: 1,
		windowSeconds: 60,
	},
	{
		blocked: false,
		limit: 10,
		rate: "minute",
		remaining: 9,
		resetAt: null,
		scope: "citations",
		used: 1,
		windowSeconds: 60,
	},
	{
		blocked: false,
		limit: 10,
		rate: "minute",
		remaining: 9,
		resetAt: null,
		scope: "api_usage",
		used: 1,
		windowSeconds: 60,
	},
];

function rpc(admit: () => BudgetDecision, events: string[]): CourtListenerCoordinatorRpc {
	return {
		admit: async () => {
			events.push("admit");
			return admit();
		},
		beginQuotaSync: async () => {
			events.push("begin-sync");
			return { kind: "started", state };
		},
		failQuotaSync: async () => ({ kind: "recorded", state }),
		recordOutcome: async (input) => {
			events.push(`record:${input.outcome.kind}`);
			return { kind: "recorded", state };
		},
		recordQuotaSync: async () => {
			events.push("complete-sync");
			return { kind: "recorded", state };
		},
		recordQuotaSyncRateLimited: async () => ({ kind: "recorded", state }),
	};
}

function options(admit: () => BudgetDecision, events: string[]) {
	return {
		coordinator: rpc(admit, events),
		now: () => NOW,
		quotaApi: {
			getUsage: async () => {
				events.push("usage");
				return { kind: "usage" as const, currentUsage: usage };
			},
		},
		token: () => "token",
	};
}

describe("case-law quota admission", () => {
	it("syncs a cold coordinator once then performs exactly one data request", async () => {
		// Given: a citation cache hit leaves case-law admission cold and the next admission is reserved.
		let attempts = 0;
		const events: string[] = [];
		const result = await requestCaseLaw(
			options(
				() =>
					++attempts === 1
						? { kind: "sync_required", state }
						: { kind: "reserved", state, token: "data" },
				events,
			),
			async () => {
				events.push("cluster-get");
				return { kind: "missing" };
			},
		);

		// When: the first case-law read needs quota synchronization.
		// Then: it issues one usage GET, re-admits once, and sends exactly one data GET.
		expect(result).toEqual({ kind: "source", source: { kind: "missing" } });
		expect(events).toEqual([
			"admit",
			"begin-sync",
			"usage",
			"complete-sync",
			"admit",
			"cluster-get",
			"record:success",
		]);
	});

	it("preserves coordinator rate and circuit retry delays without a source request", async () => {
		// Given: quota and circuit decisions each include a future coordinator deadline.
		const rateEvents: string[] = [];
		const circuitEvents: string[] = [];
		const rate = await requestCaseLaw(
			options(
				() => ({ kind: "quota_limited", retryAt: new Date(NOW.getTime() + 4_000), state }),
				rateEvents,
			),
			async () => ({ kind: "missing" }),
		);
		const circuit = await requestCaseLaw(
			options(
				() => ({ kind: "circuit_open", retryAt: new Date(NOW.getTime() + 7_000), state }),
				circuitEvents,
			),
			async () => ({ kind: "missing" }),
		);

		// When: a case-law request is denied before transport.
		// Then: typed retry guidance is preserved and no data outcome is recorded.
		expect(rate).toEqual({ kind: "indeterminate", reason: "rate_limited", retryAfterSeconds: 4 });
		expect(circuit).toEqual({
			kind: "indeterminate",
			reason: "circuit_open",
			retryAfterSeconds: 7,
		});
		expect(rateEvents).toEqual(["admit"]);
		expect(circuitEvents).toEqual(["admit"]);
	});

	it("records API 429 retry delay and a 5xx outcome without retries", async () => {
		// Given: separately admitted requests return an explicit 429 delay and a 503 source failure.
		const rateEvents: string[] = [];
		const serverEvents: string[] = [];
		const reserved = () => ({ kind: "reserved" as const, state, token: "data" });
		const rate = await requestCaseLaw(options(reserved, rateEvents), async () => ({
			kind: "rate_limited" as const,
			retryAfterSeconds: 42,
		}));
		const server = await requestCaseLaw(options(reserved, serverEvents), async () => ({
			kind: "unavailable" as const,
			failure: "server" as const,
			status: 503,
		}));

		// When: each sole actual HTTP attempt completes.
		// Then: 429 retains 42 seconds, 5xx records server_error, and neither attempts another GET.
		expect(rate).toEqual({
			kind: "source",
			source: { kind: "rate_limited", retryAfterSeconds: 42 },
		});
		expect(server).toMatchObject({ kind: "source", source: { kind: "unavailable", status: 503 } });
		expect(rateEvents).toEqual(["admit", "record:rate_limited"]);
		expect(serverEvents).toEqual(["admit", "record:server_error"]);
	});
});
