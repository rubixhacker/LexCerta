import { once } from "node:events";
import { writeSync } from "node:fs";
import type { createServiceHttpServer } from "./service-http.js";

type ServiceResources = {
	readonly port: number;
	start(): ReturnType<typeof createServiceHttpServer>;
	close(): Promise<void>;
};

export async function runServiceProcess(
	initialize: (signal: AbortSignal) => Promise<ServiceResources>,
) {
	const fatal = () => {
		// An unknown process failure cannot safely resume. Do not let Node
		// print an SDK exception that may embed credentials or legal input.
		writeSync(2, '{"event":"process_failed"}\n');
		process.exit(1);
	};
	process.once("uncaughtException", fatal);
	process.once("unhandledRejection", fatal);
	const startup = new AbortController();
	const initialized = Promise.withResolvers<void>();
	let resources: ServiceResources | undefined;
	let runtime: ReturnType<typeof createServiceHttpServer> | undefined;
	let stopping: Promise<void> | undefined;
	let exitCode = 0;
	const stop = (code = 0): Promise<void> => {
		exitCode = Math.max(exitCode, code);
		if (stopping !== undefined) return stopping;
		// A running service drains HTTP before cancelling its database work.
		// Setup has no requests to drain, so cancel identity retrieval now.
		if (runtime === undefined) startup.abort();
		const deadline = setTimeout(() => process.exit(1), 10_000);
		deadline.unref();
		stopping = (async () => {
			await initialized.promise;
			try {
				await runtime?.close();
				await resources?.close();
				clearTimeout(deadline);
				process.removeListener("SIGTERM", signalStop);
				process.removeListener("SIGINT", signalStop);
				process.exitCode = exitCode;
			} catch {
				process.exit(1);
			}
		})();
		return stopping;
	};
	const signalStop = () => {
		void stop();
	};
	process.once("SIGTERM", signalStop);
	process.once("SIGINT", signalStop);
	try {
		resources = await initialize(startup.signal);
		if (stopping === undefined) {
			runtime = resources.start();
			runtime.server.on("error", () => {
				void stop(1);
			});
			runtime.server.listen(resources.port, "0.0.0.0");
			await once(runtime.server, "listening");
		}
	} catch {
		if (stopping === undefined) {
			// Provider errors can contain authorization material and request URLs.
			console.error('{"event":"startup_failed"}');
			void stop(1);
		}
	} finally {
		initialized.resolve();
	}
	await stopping;
}
