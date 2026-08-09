import { purgeExpiredLifecycleRecords } from "./d1-lifecycle-retention.js";

export async function runScheduledRetention(
	database: D1Database,
	scheduledAt: Date,
): Promise<void> {
	await purgeExpiredLifecycleRecords(database, scheduledAt);
}
