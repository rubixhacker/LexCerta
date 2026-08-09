import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { runWithWorkerQualificationCleanup } from "./worker-qualification-cleanup.mjs";
import { waitForRecord } from "./worker-qualification-record.mjs";

test("rejects a stalled live scenario at its absolute deadline and runs cleanup", async () => {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	const events = [];
	const timers = [];
	const completion = runWithWorkerQualificationCleanup({
		clearSampler: () => events.push("sampler"),
		closeInspector: () => events.push("inspector"),
		run: () =>
			waitForRecord({
				child,
				clearTimer: () => events.push("timer"),
				deadline: 10_000,
				now: () => 9_000,
				output: () => "",
				scenarioId: "stalled",
				setTimer: (callback, delay) => {
					timers.push({ callback, delay });
					return 1;
				},
			}),
		terminateChild: async () => events.push("child"),
	});

	child.stdout.emit("data", "still running without a benchmark record\n");
	assert.equal(timers.length, 1);
	assert.equal(timers[0]?.delay, 1_000);
	timers[0]?.callback();

	await assert.rejects(completion, /did not emit benchmark record before harness deadline/);
	assert.deepEqual(events, ["timer", "sampler", "inspector", "child"]);
});
