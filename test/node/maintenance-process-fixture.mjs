import { runMaintenanceProcess } from "../../build/node/maintenance-main.js";

const mode = process.argv[2];
function waitForStop(signal, label) {
	process.stdout.write(`${label}\n`);
	const keepingAlive = setTimeout(() => {}, 60_000);
	return new Promise((resolve) =>
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(keepingAlive);
				resolve();
			},
			{ once: true },
		),
	);
}
await runMaintenanceProcess(async (signal) => {
	if (mode === "startup-failure") throw new Error("private-startup-password-sentinel");
	if (mode === "startup-abort" || mode === "late-startup") {
		await waitForStop(signal, "initializing");
		if (mode === "startup-abort") throw new Error("private-cancel-password-sentinel");
	}
	return {
		async run(runSignal) {
			if (mode === "run-failure") throw new Error("private-provider-sentinel");
			if (mode === "unhandled" || mode === "uncaught") {
				setImmediate(() => {
					if (mode === "unhandled") void Promise.reject(new Error("private-promise-sentinel"));
					else throw new Error("private-exception-sentinel");
				});
				await new Promise(() => setTimeout(() => {}, 60_000));
			}
			if (mode === "running-abort" || mode === "late-completion") {
				await waitForStop(runSignal, "running");
				if (mode === "running-abort") throw new Error("private-cancel-password-sentinel");
			}
			return {
				outcome: ["partial", "busy", "idle"].includes(mode) ? mode : "complete",
				batches: 6,
				changed: 12,
				cleanup: 1,
				lifecycle: 1,
			};
		},
		async health() {
			if (mode === "health-failure") throw new Error("private-health-sentinel");
			return {
				cleanup: { completedAt: "2026-09-12T09:00:00.000Z", overdue: false },
				lifecycle: { completedAt: "2026-09-12T03:00:00.000Z", overdue: false },
			};
		},
		async close() {
			process.stdout.write("storage-closed\n");
			if (mode === "close-hangs") await new Promise(() => setTimeout(() => {}, 60_000));
		},
	};
});
