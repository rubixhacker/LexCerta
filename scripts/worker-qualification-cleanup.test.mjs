import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
	runWithWorkerQualificationCleanup,
	terminateChildProcess,
} from "./worker-qualification-cleanup.mjs";

test("cleans sampler inspector and paused child when a scenario fails", async () => {
	const events = [];

	await assert.rejects(
		() =>
			runWithWorkerQualificationCleanup({
				clearSampler: () => events.push("sampler"),
				closeInspector: () => events.push("inspector"),
				run: async () => {
					throw new Error("scenario failure");
				},
				terminateChild: async () => events.push("child"),
			}),
		/scenario failure/,
	);

	assert.deepEqual(events, ["sampler", "inspector", "child"]);
});

test("terminates the child even when inspector cleanup fails", async () => {
	const events = [];
	await assert.rejects(
		() =>
			runWithWorkerQualificationCleanup({
				clearSampler: () => events.push("sampler"),
				closeInspector: () => {
					events.push("inspector");
					throw new Error("socket failure");
				},
				run: async () => "completed",
				terminateChild: async () => events.push("child"),
			}),
		/socket failure/,
	);
	assert.deepEqual(events, ["sampler", "inspector", "child"]);
});

test("escalates a paused process group from SIGTERM to SIGKILL", async () => {
	const child = spawn(
		process.execPath,
		["-e", "process.on('SIGTERM', () => {});setInterval(() => {}, 1e3)"],
		{
			detached: true,
			stdio: "ignore",
		},
	);
	const exit = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => resolve());
	});
	await terminateChildProcess(child, exit, 10);
	assert.notEqual(child.exitCode, 0);
});
