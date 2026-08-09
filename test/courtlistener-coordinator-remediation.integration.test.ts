import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const NOW = new Date("2026-08-09T17:00:00.000Z");

function coordinator() {
	return env.COURTLISTENER_COORDINATOR.getByName(crypto.randomUUID());
}

function windows(remaining: number) {
	return [
		{
			limit: 200,
			rate: "minute",
			remaining,
			resetAt: new Date(NOW.getTime() + 60_000),
			scope: "user",
			windowSeconds: 60,
		},
		{
			limit: 200,
			rate: "minute",
			remaining,
			resetAt: new Date(NOW.getTime() + 60_000),
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
});
