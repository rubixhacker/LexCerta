import migration from "../../migrations/0004_citation_source_cache.sql?raw";

export async function resetCitationSourceCache(database: D1Database): Promise<void> {
	await database.prepare("DROP TABLE IF EXISTS citation_fetch_leases").run();
	await database.prepare("DROP TABLE IF EXISTS citation_source_states").run();
	for (const statement of migration
		.split(";")
		.map((value) => value.trim())
		.filter(Boolean)) {
		await database.prepare(statement).run();
	}
}
