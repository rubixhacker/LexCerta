import { Pool } from "pg";
import { PostgresCourtListenerCoordinator } from "../../build/postgres/coordinator.js";
import { PgDatabase } from "../../build/postgres/database.js";
import { PostgresKeyAdmission } from "../../build/postgres/keys.js";
import { PostgresOpinionSources } from "../../build/postgres/opinions.js";
const pool = new Pool({ connectionString: process.env.LEXCERTA_PROCESS_DATABASE_URL, max: 1 });
const database = new PgDatabase(pool);
process.on("message", async ({ id, operation, input }) => {
	try {
		let result;
		if (operation === "key")
			result = await new PostgresKeyAdmission(database, "postgres-test-pepper", "test").admit(
				input.authorization,
			);
		else if (operation === "reserve")
			result = await new PostgresCourtListenerCoordinator(database, input.credentialId).admit({
				endpoint: input.endpoint,
				reservationToken: input.reservationToken,
				now: new Date(),
			});
		else if (operation === "opinionLease")
			result = await new PostgresOpinionSources(database, {}).acquireLease({
				...input,
				now: new Date(),
			});
		else throw new Error("unknown fixture operation");
		process.send({ id, result });
	} catch (error) {
		process.send({ id, error: error.name });
	}
});
process.on("disconnect", async () => {
	await pool.end();
	process.exit(0);
});
process.send({ ready: true });
