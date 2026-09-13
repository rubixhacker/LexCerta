import { encodeRecoveryRecord } from "../../build/postgres/recovery-journal.js";

// Test-only volatile journal. Production always uses the separate GCS bucket.
export function memoryRecoveryJournal(environment = "staging") {
	const records = new Map();
	return {
		environment,
		records,
		async append(restriction, signal) {
			signal?.throwIfAborted();
			const record = { version: 1, environment, restriction };
			const { key } = encodeRecoveryRecord(record);
			if (!records.has(key))
				records.set(key, {
					record,
					key,
					generation: String(records.size + 1),
					createdAt: new Date().toISOString(),
				});
			const { generation, createdAt } = records.get(key);
			return { key, generation, createdAt };
		},
	};
}
