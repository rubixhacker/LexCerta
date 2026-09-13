import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { GcsSourceObjects } from "../../build/node/gcs-source-objects.js";
import { createNeonDatabase } from "../../build/node/neon-database.js";
import { runPublicProcess } from "../../build/node/public-main.js";
import { readPublicConfig } from "../../build/node/runtime-config.js";
import { createPostgresTlsFixture, neonConnection } from "../fixtures/postgres-tls-fixture.mjs";

const settings = JSON.parse(
	await readFile(new URL("./soak-settings.json", import.meta.url), "utf8"),
);
const sockets = new Set();
const proxy = createServer((socket) => {
	const target = connect({ host: "host.docker.internal", port: settings.objectsPort });
	for (const item of [socket, target]) {
		sockets.add(item);
		item.on("error", () => item.destroy());
		item.on("close", () => sockets.delete(item));
	}
	socket.on("close", () => target.destroy());
	target.on("close", () => socket.destroy());
	socket.pipe(target).pipe(socket);
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");
const wire = await createPostgresTlsFixture(settings.connection, {
	certificate: settings.certificate,
	dockerBackend: true,
});
wire.delayMs = 1200;
const objects = new GcsSourceObjects("fixture", {
	endpoint: `http://127.0.0.1:${proxy.address().port}`,
	accessToken: async () => "synthetic-fixture-token",
});
const stopped = Promise.withResolvers();
const eventLoop = monitorEventLoopDelay({ resolution: 20 });
eventLoop.enable();
let timer;
let sampling = false;
let sampleFailure = false;
const began = performance.now();
try {
	await runPublicProcess(async (signal) => {
		const storage = await createNeonDatabase(neonConnection, "public", signal, wire.poolFactory());
		wire.delayMs = 0;
		timer = setInterval(() => {
			if (sampling) return;
			sampling = true;
			void (async () => {
				const [current, peak, events] = await Promise.all(
					["memory.current", "memory.peak", "memory.events"].map((file) =>
						readFile(`/sys/fs/cgroup/${file}`, "utf8"),
					),
				);
				const memory = process.memoryUsage();
				process.stdout.write(
					`${JSON.stringify({
						soak_metric: true,
						elapsed_ms: Math.round(performance.now() - began),
						rss: memory.rss,
						heap_used: memory.heapUsed,
						external: memory.external,
						cgroup_current: Number(current),
						cgroup_peak: Number(peak),
						cgroup_events: Object.fromEntries(
							events
								.trim()
								.split("\n")
								.map((line) => {
									const [key, value] = line.split(" ");
									return [key, Number(value)];
								}),
						),
						pool: storage.state,
						event_loop_p99_ms: Math.round(eventLoop.percentile(99) / 1e6),
					})}\n`,
				);
				eventLoop.reset();
			})()
				.catch(() => {
					sampleFailure = true;
				})
				.finally(() => {
					sampling = false;
				});
		}, 1000);
		return {
			config: readPublicConfig(process.env),
			storage: {
				database: storage.database,
				async close() {
					clearInterval(timer);
					await storage.close();
					process.stdout.write(
						`${JSON.stringify({ soak_closed: true, pool: storage.state, sample_failure: sampleFailure })}\n`,
					);
					stopped.resolve();
				},
			},
			objects: (requestSignal) => objects.withSignal(requestSignal),
			transport: (request) => {
				const url = new URL(request.url);
				assert.equal(url.origin, "https://www.courtlistener.com");
				return fetch(
					`http://host.docker.internal:${settings.sourcePort}${url.pathname}${url.search}`,
					{
						method: request.method,
						headers: request.headers,
						body: request.body,
						signal: request.signal,
						duplex: "half",
						redirect: "manual",
					},
				);
			},
		};
	});
	await stopped.promise;
} finally {
	clearInterval(timer);
	eventLoop.disable();
	await wire.close();
	for (const socket of sockets) socket.destroy();
	await new Promise((resolve) => proxy.close(resolve));
}
