import type { TransactionDatabase } from "./database.js";
import { claimMaintenance } from "./maintenance.js";
import { advanceMaintenance } from "./maintenance-steps.js";
import type { SourceObjects } from "./objects.js";

export async function runMaintenance(
	database: TransactionDatabase,
	objects: SourceObjects,
	budgetMs = 540_000,
) {
	if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 540_000)
		throw new RangeError("invalid maintenance budget");
	const deadline = performance.now() + budgetMs;
	const claim = await claimMaintenance(database);
	const counts = { batches: 0, changed: 0, cleanup: 0, lifecycle: 0 };
	if (claim.kind !== "acquired") return { outcome: claim.kind, ...counts };
	const lease = claim.lease;
	try {
		// Each unit has bounded SQL and object requests. Leave time for its last
		// in-flight operation and checkpoint; the process owns the hard deadline.
		while (performance.now() < deadline - 15_000) {
			await lease.renew();
			const progress = await lease.next();
			if (progress === null) {
				await lease.release("complete");
				return { outcome: "complete" as const, ...counts };
			}
			const step = await advanceMaintenance(
				lease,
				progress,
				objects,
				Math.max(1, Math.min(30_000, Math.floor(deadline - performance.now() - 15_000))),
			);
			counts.batches += 1;
			counts.changed += step.changed;
			if (step.completed !== null) counts[step.completed] += 1;
			if (step.blocked) break;
		}
		await lease.release("partial");
		return { outcome: "partial" as const, ...counts };
	} catch (error) {
		// Cancellation or a stolen lease can make release unavailable. Keep the
		// durable unfinished state for the next owner; never reset its cursors.
		await lease.release("failed").catch(() => undefined);
		throw error;
	}
}
