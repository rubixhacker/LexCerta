import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecureContext, TLSSocket } from "node:tls";
import { Pool } from "pg";

export const neonHost = "ep-fixture-123.us-east-2.aws.neon.tech";
export const neonConnection = {
	environment: "staging",
	host: neonHost,
	password: "synthetic-neon-private-password-32",
};

// TLS terminates only at this loopback fixture, then forwards PostgreSQL wire
// traffic to the existing disposable local database. No production DNS or CA
// store is changed. The production factory receives no fixture environment flag.
export async function createPostgresTlsFixture(
	connection,
	{ certificateHost = neonHost, certificate, dockerBackend = false } = {},
) {
	const upstream = new URL(connection);
	assert.ok(
		["127.0.0.1", "localhost", "[::1]"].includes(upstream.hostname) ||
			(dockerBackend && upstream.hostname === "host.docker.internal"),
	);
	const directory = await mkdtemp(join(tmpdir(), "lexcerta-pg-tls-"));
	const sockets = new Set();
	const failures = [];
	let received = 0;
	let encrypted = 0;
	let delayMs = 0;
	let refuseTls = false;
	const timers = new Set();
	let server;
	try {
		if (!certificate)
			execFileSync(
				"openssl",
				[
					"req",
					"-x509",
					"-newkey",
					"rsa:2048",
					"-nodes",
					"-days",
					"1",
					"-subj",
					`/CN=${certificateHost}`,
					"-addext",
					`subjectAltName=DNS:${certificateHost}`,
					"-keyout",
					join(directory, "key.pem"),
					"-out",
					join(directory, "cert.pem"),
				],
				{ stdio: "ignore" },
			);
		const cert = certificate?.cert ?? (await readFile(join(directory, "cert.pem"), "utf8"));
		const key = certificate?.key ?? (await readFile(join(directory, "key.pem"), "utf8"));
		const secureContext = createSecureContext({ cert, key, minVersion: "TLSv1.2" });
		const track = (socket) => {
			sockets.add(socket);
			socket.on("error", () => {});
			socket.on("close", () => sockets.delete(socket));
			return socket;
		};
		server = createServer((socket) => {
			track(socket);
			received += 1;
			socket.once("data", (data) => {
				try {
					assert.equal(data.toString("hex"), "0000000804d2162f");
				} catch (error) {
					failures.push(error);
					socket.destroy();
					return;
				}
				const timer = setTimeout(() => {
					timers.delete(timer);
					if (socket.destroyed) return;
					if (refuseTls) return socket.end("N");
					socket.write("S");
					const tls = track(new TLSSocket(socket, { isServer: true, secureContext }));
					tls.once("secure", () => {
						encrypted += 1;
						const backend = track(
							connect({ host: upstream.hostname, port: Number(upstream.port) }),
						);
						tls.pipe(backend).pipe(tls);
						tls.on("close", () => backend.destroy());
						backend.on("close", () => tls.destroy());
					});
				}, delayMs);
				timers.add(timer);
			});
		});
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		return {
			certificate: { cert, key },
			get state() {
				return { received, encrypted, active: sockets.size };
			},
			set delayMs(value) {
				delayMs = value;
			},
			set refuseTls(value) {
				refuseTls = value;
			},
			disconnect() {
				for (const socket of sockets) socket.destroy();
			},
			poolFactory({ trusted = true, configure = (options) => options } = {}) {
				return (options) =>
					new Pool(
						configure({
							...options,
							host: "127.0.0.1",
							port: server.address().port,
							user: decodeURIComponent(upstream.username),
							password: decodeURIComponent(upstream.password),
							database: decodeURIComponent(upstream.pathname.slice(1)),
							ssl: { ...options.ssl, servername: options.host, ...(trusted ? { ca: cert } : {}) },
						}),
					);
			},
			async close() {
				for (const timer of timers) clearTimeout(timer);
				for (const socket of sockets) socket.destroy();
				await new Promise((resolve) => server.close(resolve));
				await rm(directory, { recursive: true, force: true });
				assert.deepEqual(failures, []);
			},
		};
	} catch (error) {
		for (const socket of sockets) socket.destroy();
		server?.close();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}
