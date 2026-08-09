import { env } from "cloudflare:test";
import migration from "../../migrations/0005_opinion_source_cache.sql?raw";

export async function resetOpinionSourceCache(): Promise<void> {
	const objects = (await env.OPINION_CACHE.list()).objects.map(({ key }) => key);
	if (objects.length > 0) await env.OPINION_CACHE.delete(objects);
	for (const table of [
		"opinion_source_fetch_leases",
		"opinion_source_object_versions",
		"opinion_source_states",
	]) {
		await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
	}
	for (const statement of migration
		.split(";")
		.map((value) => value.trim())
		.filter(Boolean)) {
		await env.DB.prepare(statement).run();
	}
}
