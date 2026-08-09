// This supervisory cap allows local workerd and Vitest startup while remaining bounded.
// It is intentionally separate from the 5,000 ms runner-isolate wall-time resource gate.
export const WORKER_QUALIFICATION_HARNESS_RECORD_DEADLINE_MS = 60_000;
const MARKER = "WORKER_QUALIFICATION_BENCHMARK=";

export function waitForRecord(input) {
	if (!Number.isFinite(input.deadline))
		return Promise.reject(new TypeError("worker qualification record deadline must be finite"));
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (completion, value) => {
			if (settled) return;
			settled = true;
			input.child.stdout.removeListener("data", check);
			input.child.removeListener("exit", onExit);
			input.clearTimer(timer);
			completion(value);
		};
		const check = () => {
			const line = input
				.output()
				.split("\n")
				.find((value) => value.includes(MARKER));
			if (line === undefined) return;
			try {
				const record = JSON.parse(line.slice(line.indexOf(MARKER) + MARKER.length).trim());
				if (record.scenario !== input.scenarioId)
					finish(reject, new TypeError(`unexpected benchmark record for ${input.scenarioId}`));
				else finish(resolve, record);
			} catch (error) {
				finish(reject, error);
			}
		};
		const onExit = () => {
			check();
			if (!settled)
				finish(reject, new TypeError(`missing benchmark record for ${input.scenarioId}`));
		};
		input.child.stdout.on("data", check);
		input.child.once("exit", onExit);
		const timer = input.setTimer(
			() =>
				finish(
					reject,
					new TypeError(
						`worker qualification ${input.scenarioId} did not emit benchmark record before harness deadline`,
					),
				),
			Math.max(0, input.deadline - input.now()),
		);
		check();
	});
}
