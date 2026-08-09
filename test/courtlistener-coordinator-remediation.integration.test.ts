import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-08-09T17:00:00.000Z");

function coordinator() {
	return env.COURTLISTENER_COORDINATOR.getByName(crypto.randomUUID());
}

function windows(remaining: number, resetMilliseconds = 60_000) {
	return [
		{
			limit: 200,
			rate: "minute",
			remaining,
			resetAt: new Date(NOW.getTime() + resetMilliseconds),
			scope: "user",
			windowSeconds: 60,
		},
		{
			limit: 200,
			rate: "minute",
			remaining,
			resetAt: new Date(NOW.getTime() + resetMilliseconds),
			scope: "api_usage",
			windowSeconds: 60,
		},
		{
			limit: 200,
			rate: "minute",
			remaining,
			resetAt: new Date(NOW.getTime() + resetMilliseconds),
			scope: "citations",
			windowSeconds: 60,
		},
	] as const;
}

async function confirm(stub: ReturnType<typeof coordinator>): Promise<void> {
	const token = crypto.randomUUID();
	await stub.beginQuotaSync({ now: NOW, syncToken: token });
	await stub.recordQuotaSync({ now: NOW, syncToken: token, windows: windows(101) });
}

describe("CourtListenerCoordinator remediation", () => {
	it("persists one correlated quota-sync reservation and consumes it after eviction", async () => {
		// Given: a coordinator with one in-flight quota synchronization.
		const stub = coordinator();
		const token = crypto.randomUUID();
		await stub.beginQuotaSync({ now: NOW, syncToken: token });
		const pending = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ readonly state_json: string }>("SELECT state_json FROM courtlistener_budget_state")
				.one(),
		);

		// When: its persisted JSON is inspected, then workerd evicts it before completion.
		const parsed = JSON.parse(pending.state_json) as {
			pendingReservations: readonly { readonly kind: string; readonly token: string }[];
		};
		await evictDurableObject(stub);
		const completed = await stub.recordQuotaSync({
			now: NOW,
			syncToken: token,
			windows: windows(1),
		});

		// Then: exactly the matching quota-sync reservation existed and completion consumed it.
		expect(parsed.pendingReservations).toMatchObject([{ kind: "quota_sync", token }]);
		expect(completed).toMatchObject({ kind: "recorded", state: { pendingReservations: [] } });
	});

	it("caps pending reservations at one hundred without poisoning persisted state", async () => {
		// Given: confirmed capacity for one hundred citation reservations.
		const stub = coordinator();
		await confirm(stub);

		// When: one hundred opaque reservations are retained before a one-hundred-first request.
		for (let index = 0; index < 100; index += 1) {
			expect(
				await stub.admit({ endpoint: "citation", now: NOW, reservationToken: crypto.randomUUID() }),
			).toMatchObject({ kind: "reserved" });
		}
		const denied = await stub.admit({
			endpoint: "citation",
			now: NOW,
			reservationToken: crypto.randomUUID(),
		});
		await evictDurableObject(stub);
		const readable = await runInDurableObject(stub, (_instance, state) =>
			state.storage.sql
				.exec<{ readonly state_json: string }>("SELECT state_json FROM courtlistener_budget_state")
				.one(),
		);

		// Then: capacity denies without a 101st write and the evicted SQLite state remains parseable.
		expect(denied).toMatchObject({ kind: "reservation_capacity_exhausted" });
		expect(JSON.parse(readable.state_json)).toMatchObject({
			pendingReservations: expect.any(Array),
		});
		expect(
			await stub.admit({ endpoint: "citation", now: NOW, reservationToken: crypto.randomUUID() }),
		).toMatchObject({ kind: "reservation_capacity_exhausted" });
	});

	it("persists exhausted api-usage sync capacity across eviction until its reset", async () => {
		// Given: confirmed data and a final one-request api_usage allowance.
		const stub = coordinator();
		const initial = crypto.randomUUID();
		const confirmedAt = new Date(NOW.getTime() - 15 * 60_000);
		await stub.beginQuotaSync({ now: confirmedAt, syncToken: initial });
		await stub.recordQuotaSync({
			now: confirmedAt,
			syncToken: initial,
			windows: windows(1, 60 * 60_000),
		});
		const finalToken = crypto.randomUUID();
		const started = await stub.beginQuotaSync({ now: NOW, syncToken: finalToken });
		expect(started.kind).toBe("started");
		if (started.state.quota.kind !== "sync_in_progress") throw new Error("expected a sync lease");
		expect(
			started.state.quota.prior?.windows.find((window) => window.scope === "api_usage")?.remaining,
		).toBe(0);

		// When: the upstream sync fails, workerd evicts state, and callers arrive before and at reset.
		await stub.failQuotaSync({ now: NOW, syncToken: finalToken });
		await evictDurableObject(stub);
		const backoff = await stub.beginQuotaSync({
			now: new Date(NOW.getTime() + 15 * 60_000 - 1),
			syncToken: crypto.randomUUID(),
		});
		const exhausted = await stub.beginQuotaSync({
			now: new Date(NOW.getTime() + 15 * 60_000),
			syncToken: crypto.randomUUID(),
		});
		await evictDurableObject(stub);
		const boundary = await stub.beginQuotaSync({
			now: new Date(NOW.getTime() + 60 * 60_000),
			syncToken: crypto.randomUUID(),
		});

		// Then: exhausted api_usage fails closed until exact reset permits one new reservation.
		expect(backoff).toMatchObject({ kind: "not_due" });
		expect(exhausted).toMatchObject({
			kind: "quota_sync_quota_exhausted",
			retryAt: new Date(NOW.getTime() + 60 * 60_000),
		});
		expect(boundary).toMatchObject({
			kind: "started",
			state: { pendingReservations: [{ kind: "quota_sync" }] },
		});
	});

	it("reapplies a completed data reservation over a stale quota-sync snapshot", async () => {
		const stub = coordinator();
		const initial = crypto.randomUUID();
		const confirmedAt = new Date(NOW.getTime() - 15 * 60_000);
		await stub.beginQuotaSync({ now: confirmedAt, syncToken: initial });
		await stub.recordQuotaSync({ now: confirmedAt, syncToken: initial, windows: windows(1) });
		const dataToken = crypto.randomUUID();
		await stub.admit({
			endpoint: "citation",
			now: new Date(NOW.getTime() - 1),
			reservationToken: dataToken,
		});
		const syncToken = crypto.randomUUID();
		const sync = await stub.beginQuotaSync({ now: NOW, syncToken });
		expect(sync).toMatchObject({
			kind: "started",
			state: { quota: { capturedDataReservationEndpoints: ["citation"] } },
		});
		await stub.recordOutcome({
			endpoint: "citation",
			now: NOW,
			outcome: { kind: "success" },
			reservationToken: dataToken,
		});
		await stub.recordQuotaSync({ now: NOW, syncToken, windows: windows(1) });
		await evictDurableObject(stub);
		expect(
			await stub.admit({ endpoint: "citation", now: NOW, reservationToken: crypto.randomUUID() }),
		).toMatchObject({ kind: "quota_exhausted" });
	});
});
