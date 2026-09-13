import { Pool } from "pg";
import { PgDatabase } from "../../build/postgres/database.js";
import { claimMaintenance } from "../../build/postgres/maintenance.js";

const connection = process.env.LEXCERTA_PROCESS_DATABASE_URL;
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(connection).hostname))
	throw new Error("maintenance fixture requires loopback PostgreSQL");
const pool = new Pool({ connectionString: connection, max: 2 });
const database = new PgDatabase(pool);
let lease;
process.on("message", async ({ id, operation }) => {
	try {
		let result;
		if (operation === "claim") {
			const claim = await claimMaintenance(database);
			lease = claim.kind === "acquired" ? claim.lease : undefined;
			result = claim.kind;
		} else if (operation === "next") result = await lease.next();
		else throw new Error("unknown maintenance fixture operation");
		process.send({ id, result });
	} catch (error) {
		process.send({ id, error: error.name });
	}
});
process.on("disconnect", async () => {
	await pool.end();
});
process.send({ ready: true });
