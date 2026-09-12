import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
// Durable only so another test process can inspect an upload after SIGKILL.
// No production implementation imports this fixture.
export class DiskSourceObjects {
	constructor(directory, hooks = {}) {
		this.directory = directory;
		this.hooks = hooks;
	}
	path(key) {
		return join(this.directory, `${Buffer.from(key).toString("base64url")}.json`);
	}
	async put(key, bytes, metadata) {
		const value = {
			key,
			generation: "1",
			bytes: Buffer.from(bytes).toString("base64"),
			metadata,
			createdAt: new Date().toISOString(),
		};
		await writeFile(this.path(key), JSON.stringify(value), { flag: "wx" });
		await this.hooks.upload?.();
		return { ...value, bytes: Buffer.from(value.bytes, "base64") };
	}
	async read(key, generation) {
		try {
			const value = JSON.parse(await readFile(this.path(key), "utf8"));
			return value.generation === generation
				? { ...value, bytes: Buffer.from(value.bytes, "base64") }
				: null;
		} catch (error) {
			if (error.code === "ENOENT") return null;
			throw error;
		}
	}
	async generation(key) {
		return (await this.read(key, "1"))?.generation ?? null;
	}
	async remove(key, generation) {
		const value = await this.read(key, generation);
		if (!value) return;
		await unlink(this.path(key));
		await this.hooks.deletion?.();
	}
	async list() {
		const values = await Promise.all(
			(await readdir(this.directory)).map(async (name) =>
				JSON.parse(await readFile(join(this.directory, name), "utf8")),
			),
		);
		return {
			objects: values.map((value) => ({
				key: value.key,
				generation: value.generation,
				createdAt: new Date(value.createdAt),
			})),
			nextPageToken: null,
		};
	}
}
