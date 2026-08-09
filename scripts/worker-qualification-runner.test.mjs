import assert from "node:assert/strict";
import test from "node:test";
import { runWithWorkerQualificationCleanup } from "./worker-qualification-cleanup.mjs";
import {
	RUNNER_TARGET_ID,
	closeWorkerQualificationInspectors,
	runWithWorkerQualificationDeadline,
	selectWorkerQualificationTargets,
} from "./worker-qualification-runner.mjs";

test("selects the exact Vitest runner target and keeps core entry as control", () => {
	// Given: the workerd inspector exposes its paused control target and the Vitest application runner.
	const targets = [
		{ id: "core:entry", webSocketDebuggerUrl: "ws://control" },
		{ id: RUNNER_TARGET_ID, webSocketDebuggerUrl: "ws://runner" },
	];

	// When: the harness chooses its CDP targets.
	const selected = selectWorkerQualificationTargets(targets);

	// Then: only the exact runner is used for application measurement.
	assert.deepEqual(selected, { control: targets[0], measurement: targets[1] });
});

test("rejects an inspector target whose runner identity differs from Vitest", () => {
	// Given: a worker target that is not the known Vitest application runner.
	const targets = [
		{ id: "core:entry", webSocketDebuggerUrl: "ws://control" },
		{ id: "core:user:another-runner", webSocketDebuggerUrl: "ws://wrong" },
	];

	// When / Then: target selection fails closed rather than profiling the wrong isolate.
	assert.throws(() => selectWorkerQualificationTargets(targets), /runner target/);
});

test("rejects a stall before record waiting at the scenario deadline and cleans up", async () => {
	// Given: a spawned scenario that stalls before it can begin waiting for its benchmark record.
	const events = [];
	const timers = [];
	const completion = runWithWorkerQualificationCleanup({
		clearSampler: () => events.push("sampler"),
		closeInspector: () => events.push("inspectors"),
		run: () =>
			runWithWorkerQualificationDeadline({
				clearTimer: () => events.push("deadline-cleared"),
				deadline: 10_000,
				now: () => 9_000,
				run: () => new Promise(() => {}),
				scenarioId: "stalled-before-record",
				setTimer: (callback, delay) => {
					timers.push({ callback, delay });
					return 1;
				},
			}),
		terminateChild: async () => events.push("child"),
	});

	// When: the absolute deadline fires while target discovery or initial CDP remains stalled.
	assert.equal(timers[0]?.delay, 1_000);
	timers[0]?.callback();

	// Then: the scenario rejects and always closes measurement resources and its process group.
	await assert.rejects(completion, /stalled-before-record exceeded harness deadline/);
	assert.deepEqual(events, ["deadline-cleared", "sampler", "inspectors", "child"]);
});

test("closes both control and runner CDP clients when control cleanup fails", () => {
	// Given: a failing control CDP client and a separate application-runner CDP client.
	const closed = [];
	const control = {
		close: () => {
			closed.push("control");
			throw new Error("control close");
		},
	};
	const measurement = { close: () => closed.push("measurement") };

	// When / Then: cleanup preserves the control failure after closing the runner client as well.
	assert.throws(() => closeWorkerQualificationInspectors(control, measurement), /control close/);
	assert.deepEqual(closed, ["control", "measurement"]);
});
