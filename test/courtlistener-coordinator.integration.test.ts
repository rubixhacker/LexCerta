import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { COURTLISTENER_LEASE_MILLISECONDS } from "../src/courtlistener/budget.js";
import { CourtListenerCoordinatorStateError } from "../src/courtlistener/coordinator.js";

const NOW = new Date("2026-08-09T17:00:00.000Z");

function later(milliseconds: number): Date {
	return new Date(NOW.getTime() + milliseconds);
}

function coordinatorFor(credential = crypto.randomUUID()) {
	return env.COURTLISTENER_COORDINATOR.getByName(credential);
}

function quotaWindows(remaining: number) {
	return [
		{
			limit: 5,
			rate: "minute",
			remaining,
			resetAt: later(60_000),
			scope: "user",
			windowSeconds: 60,
		},
		{
			limit: 5,
			rate: "minute",
			remaining,
			resetAt: later(60_000),
			scope: "citations",
			windowSeconds: 60,
		},
	] as const;
}

async function confirmQuota(
	coordinator: ReturnType<typeof coordinatorFor>,
	remaining = 2,
): Promise<void> {
	const token = crypto.randomUUID();
	expect(await coordinator.beginQuotaSync({ now: NOW, syncToken: token })).toMatchObject({
		kind: "started",
	});
	expect(
		await coordinator.recordQuotaSync({
			now: NOW,
			syncToken: token,
			windows: quotaWindows(remaining),
		}),
	).toMatchObject({ kind: "recorded" });
}

describe("CourtListenerCoordinator Durable Object", () => {
	it("serializes a cold quota sync and reservations so confirmed capacity cannot overspend", async () => {
		// Given: one named credential coordinator with no previously confirmed quota.
		const coordinator = coordinatorFor();
		const firstSync = crypto.randomUUID();
		const secondSync = crypto.randomUUID();

		// When: two cold sync starts and then two one-slot citation admissions arrive concurrently.
		const starts = await Promise.all([
			coordinator.beginQuotaSync({ now: NOW, syncToken: firstSync }),
			coordinator.beginQuotaSync({ now: NOW, syncToken: secondSync }),
		]);
		const [firstStart] = starts;
		const startedToken = firstStart.kind === "started" ? firstSync : secondSync;
		await coordinator.recordQuotaSync({
			now: NOW,
			syncToken: startedToken,
			windows: quotaWindows(1),
		});
		const admissions = await Promise.all([
			coordinator.admit({ endpoint: "citation", now: NOW, reservationToken: crypto.randomUUID() }),
			coordinator.admit({ endpoint: "citation", now: NOW, reservationToken: crypto.randomUUID() }),
		]);

		// Then: exactly one sync owns the cold token and only one reservation consumes the slot.
		expect(starts.filter((result) => result.kind === "started")).toHaveLength(1);
		expect(starts.filter((result) => result.kind === "already_in_progress")).toHaveLength(1);
		expect(admissions.filter((result) => result.kind === "reserved")).toHaveLength(1);
		expect(admissions.filter((result) => result.kind === "quota_exhausted")).toHaveLength(1);
	});

	it("persists reservations across workerd eviction without overspending", async () => {
		// Given: a named coordinator with a single confirmed citation slot consumed by one reservation.
		const coordinator = coordinatorFor();
		await confirmQuota(coordinator, 1);
		const first = await coordinator.admit({
			endpoint: "citation",
			now: NOW,
			reservationToken: crypto.randomUUID(),
		});
		expect(first.kind).toBe("reserved");

		// When: workerd evicts the instance before another admission reaches the same named object.
		await evictDurableObject(coordinator);
		const second = await coordinator.admit({
			endpoint: "citation",
			now: NOW,
			reservationToken: crypto.randomUUID(),
		});

		// Then: the SQLite state survives and prevents a second spend.
		expect(second.kind).toBe("quota_exhausted");
	});

	it("recovers expired sync and reservation leases after workerd eviction at their exact boundary", async () => {
		// Given: one coordinator with an unfinished sync and another with an abandoned reservation.
		const syncing = coordinatorFor();
		const syncToken = crypto.randomUUID();
		await syncing.beginQuotaSync({ now: NOW, syncToken });
		const reserving = coordinatorFor();
		await confirmQuota(reserving, 2);
		await reserving.admit({
			endpoint: "citation",
			now: NOW,
			reservationToken: crypto.randomUUID(),
		});
		await Promise.all([evictDurableObject(syncing), evictDurableObject(reserving)]);

		// When: a caller reaches both recovered objects exactly when their leases expire.
		const [syncDecision, reservationDecision] = await Promise.all([
			syncing.admit({
				endpoint: "citation",
				now: later(COURTLISTENER_LEASE_MILLISECONDS),
				reservationToken: crypto.randomUUID(),
			}),
			reserving.admit({
				endpoint: "citation",
				now: later(COURTLISTENER_LEASE_MILLISECONDS),
				reservationToken: crypto.randomUUID(),
			}),
		]);

		// Then: a stuck first sync fails closed and an abandoned reservation becomes a circuit failure.
		expect(syncDecision.kind).toBe("sync_unavailable");
		expect(reservationDecision).toMatchObject({
			kind: "reserved",
			state: {
				circuits: { citation: { consecutiveFailures: 1, kind: "closed" } },
				pendingReservations: [expect.anything()],
			},
		});
	});

	it("persists independent citation and case-law circuit states", async () => {
		// Given: confirmed capacity and three separate citation timeouts.
		const coordinator = coordinatorFor();
		await confirmQuota(coordinator, 8);
		for (const token of [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]) {
			expect(
				await coordinator.admit({ endpoint: "citation", now: NOW, reservationToken: token }),
			).toMatchObject({ kind: "reserved" });
			await coordinator.recordOutcome({
				endpoint: "citation",
				now: NOW,
				outcome: { kind: "timeout" },
				reservationToken: token,
			});
		}
		await evictDurableObject(coordinator);

		// When: each endpoint is admitted through the reconstructed object.
		const citation = await coordinator.admit({
			endpoint: "citation",
			now: later(1),
			reservationToken: crypto.randomUUID(),
		});
		const caseLaw = await coordinator.admit({
			endpoint: "case_law",
			now: later(1),
			reservationToken: crypto.randomUUID(),
		});

		// Then: the open citation circuit does not block the separately persisted case-law circuit.
		expect(citation.kind).toBe("circuit_open");
		expect(caseLaw.kind).toBe("reserved");
	});

	it("rejects unknown tokens and malformed persisted state without a permissive fallback", async () => {
		// Given: a coordinator with a confirmed state but no issued sync or reservation token.
		const coordinator = coordinatorFor();
		await confirmQuota(coordinator);

		// When: callers complete unknown tokens and an operator-corrupted state is read after eviction.
		expect(
			await coordinator.failQuotaSync({ now: NOW, syncToken: crypto.randomUUID() }),
		).toMatchObject({ kind: "unknown_sync_token" });
		expect(
			await coordinator.recordOutcome({
				endpoint: "citation",
				now: NOW,
				outcome: { kind: "success" },
				reservationToken: crypto.randomUUID(),
			}),
		).toMatchObject({ kind: "unknown_reservation" });
		await runInDurableObject(coordinator, (_instance, state) => {
			state.storage.sql.exec(
				"UPDATE courtlistener_budget_state SET state_json = 'not-json' WHERE singleton = 1",
			);
		});
		await evictDurableObject(coordinator);

		// Then: the object fails closed instead of resetting to a permissive fresh state.
		const errorName = await runInDurableObject(coordinator, async (instance) => {
			try {
				await instance.admit({
					endpoint: "citation",
					now: NOW,
					reservationToken: crypto.randomUUID(),
				});
			} catch (error) {
				if (error instanceof Error) return error.name;
				throw error;
			}
			return undefined;
		});
		expect(errorName).toBe(CourtListenerCoordinatorStateError.name);
	});
});
