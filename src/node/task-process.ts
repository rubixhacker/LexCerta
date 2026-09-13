import { writeSync } from "node:fs";

type TaskResources = {
	run(signal: AbortSignal): Promise<0 | 1>;
	close(): Promise<void>;
};

// Operational tasks share shutdown and failure handling, while their entry
// points retain their own identities, work and explicitly sanitized output.
export async function runTaskProcess(
	name: "maintenance" | "migration",
	create: (signal: AbortSignal) => Promise<TaskResources>,
) {
	const controller = new AbortController();
	let backstop: ReturnType<typeof setTimeout> | undefined;
	let resources: TaskResources | undefined;
	let started = false;
	const failure = () => writeSync(2, `${JSON.stringify({ event: `${name}_failed` })}\n`);
	const fatal = () => {
		failure();
		process.exit(1);
	};
	const stop = () => {
		controller.abort();
		backstop ??= setTimeout(() => process.exit(1), 10_000);
	};
	const deadline = setTimeout(stop, name === "maintenance" ? 540_000 : 120_000);
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	process.once("uncaughtException", fatal);
	process.once("unhandledRejection", fatal);
	try {
		resources = await create(controller.signal);
		controller.signal.throwIfAborted();
		started = true;
		process.exitCode = await resources.run(controller.signal);
		controller.signal.throwIfAborted();
	} catch {
		if (started) failure();
		else writeSync(2, `${JSON.stringify({ event: `${name}_startup_failed` })}\n`);
		process.exitCode = 1;
	} finally {
		clearTimeout(deadline);
		controller.abort();
		backstop ??= setTimeout(() => process.exit(1), 10_000);
		try {
			await resources?.close();
		} catch {
			process.exitCode = 1;
		}
		clearTimeout(backstop);
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		process.removeListener("uncaughtException", fatal);
		process.removeListener("unhandledRejection", fatal);
	}
}
