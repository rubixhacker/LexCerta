// Faults are injected around real PostgreSQL messages, never into production code.
export function poolWithCommitFault(pool, { afterCommit = true, onCommit }) {
	return {
		async connect() {
			const client = await pool.connect();
			return {
				async query(...args) {
					if (args[0] === "COMMIT" && !afterCommit) await onCommit();
					const result = await client.query(...args);
					if (args[0] === "COMMIT" && afterCommit) await onCommit();
					return result;
				},
				release: (...args) => client.release(...args),
			};
		},
	};
}
