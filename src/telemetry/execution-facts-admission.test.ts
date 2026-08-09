import { describe, expect, it } from "vitest";
import type { CourtListenerApi } from "../courtlistener/api.js";
import type { BudgetDecision } from "../courtlistener/budget-contract.js";
import { initialCourtListenerBudgetState } from "../courtlistener/budget.js";
import { requestCaseLaw } from "../courtlistener/case-law-admission.js";
import type { CourtListenerCoordinatorRpc } from "../courtlistener/coordinator.js";
import { createCourtListenerCitationGateway } from "../courtlistener/gateway.js";
import { createExecutionFactCollector } from "./execution-facts.js";

const NOW = new Date("2026-08-09T12:00:00.000Z");
const RETRY_AT = new Date("2026-08-09T12:00:30.000Z");

type AdmissionCase = {
	readonly decision: BudgetDecision;
	readonly name: string;
	readonly reason: "quota_unknown" | "rate_limited";
	readonly upstreamStatus: "quota_unknown" | "quota_limited";
};

const ADMISSION_CASES = [
	{
		decision: {
			kind: "quota_limited",
			retryAt: RETRY_AT,
			state: initialCourtListenerBudgetState(),
		},
		name: "known rate limit",
		reason: "rate_limited",
		upstreamStatus: "quota_limited",
	},
	{
		decision: { kind: "quota_exhausted", retryAt: null, state: initialCourtListenerBudgetState() },
		name: "confirmed quota exhaustion",
		reason: "quota_unknown",
		upstreamStatus: "quota_limited",
	},
	{
		decision: { kind: "sync_in_progress", state: initialCourtListenerBudgetState() },
		name: "synchronization in progress",
		reason: "quota_unknown",
		upstreamStatus: "quota_unknown",
	},
	{
		decision: {
			kind: "sync_unavailable",
			retryAt: RETRY_AT,
			state: initialCourtListenerBudgetState(),
		},
		name: "synchronization unavailable",
		reason: "quota_unknown",
		upstreamStatus: "quota_unknown",
	},
] as const satisfies readonly AdmissionCase[];

describe("admission execution facts", () => {
	it.each(ADMISSION_CASES)("reports citation $name truthfully", async (testCase) => {
		// Given: citation admission has either confirmed quota evidence or unresolved synchronization.
		const collector = createExecutionFactCollector();
		const gateway = createCourtListenerCitationGateway({
			api: citationApi(),
			coordinator: coordinatorFor(testCase.decision),
			executionFacts: collector,
			now: () => NOW,
			token: () => "opaque-token",
		});

		// When: the gateway is denied before an outbound citation request.
		const observation = await gateway.lookup({
			normalizedCitation: "347 U.S. 483",
			page: 483,
			reporter: "U.S.",
			volume: 347,
		});

		// Then: returned guidance and the emitted execution fact agree about quota certainty.
		expect(observation).toMatchObject({ kind: "indeterminate", reason: testCase.reason });
		expect(collector.snapshot()).toMatchObject({
			circuitStatus: "closed",
			upstreamStatus: testCase.upstreamStatus,
		});
	});

	it.each(ADMISSION_CASES)("reports case-law $name truthfully", async (testCase) => {
		// Given: case-law admission has the same independently classified coordinator decision.
		const collector = createExecutionFactCollector();

		// When: it is denied before the source request begins.
		const result = await requestCaseLaw(
			{
				coordinator: coordinatorFor(testCase.decision),
				executionFacts: collector,
				now: () => NOW,
				quotaApi: citationApi(),
				token: () => "opaque-token",
			},
			async () => ({ kind: "missing" }),
		);

		// Then: telemetry never turns synchronization uncertainty into a confirmed limit.
		expect(result).toMatchObject({ kind: "indeterminate", reason: testCase.reason });
		expect(collector.snapshot()).toMatchObject({
			circuitStatus: "closed",
			upstreamStatus: testCase.upstreamStatus,
		});
	});
});

function citationApi(): CourtListenerApi {
	return {
		getUsage: async () => ({ kind: "malformed_response" }),
		lookupCitation: async () => ({ kind: "absent", normalizedCitation: "347 U.S. 483" }),
	};
}

function coordinatorFor(decision: BudgetDecision): CourtListenerCoordinatorRpc {
	const state = decision.state;
	return {
		admit: async () => decision,
		beginQuotaSync: async () => ({ kind: "not_due", retryAt: RETRY_AT, state }),
		failQuotaSync: async () => ({ kind: "recorded", state }),
		recordOutcome: async () => ({ kind: "recorded", state }),
		recordQuotaSync: async () => ({ kind: "recorded", state }),
		recordQuotaSyncRateLimited: async () => ({ kind: "recorded", state }),
	};
}
