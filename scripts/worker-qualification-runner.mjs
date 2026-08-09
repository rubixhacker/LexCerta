export const CONTROL_TARGET_ID = "core:entry";
export const RUNNER_TARGET_ID = "core:user:vitest-pool-workers-runner-";

export function selectWorkerQualificationTargets(targets) {
	if (!Array.isArray(targets)) throw new TypeError("workerd inspector targets must be an array");
	const control = targets.find((target) => target?.id === CONTROL_TARGET_ID);
	const measurement = targets.find((target) => target?.id === RUNNER_TARGET_ID);
	if (control === undefined) throw new TypeError("workerd inspector control target did not appear");
	if (measurement === undefined)
		throw new TypeError(`workerd inspector runner target ${RUNNER_TARGET_ID} did not appear`);
	if (
		typeof control.webSocketDebuggerUrl !== "string" ||
		typeof measurement.webSocketDebuggerUrl !== "string"
	)
		throw new TypeError("workerd inspector target has no WebSocket debugger URL");
	return { control, measurement };
}

export function closeWorkerQualificationInspectors(control, measurement) {
	try {
		control?.close();
	} finally {
		measurement?.close();
	}
}

export function runWithWorkerQualificationDeadline(input) {
	if (!Number.isFinite(input.deadline))
		return Promise.reject(new TypeError("worker qualification deadline must be finite"));
	return new Promise((resolve, reject) => {
		let settled = false;
		const controller = new AbortController();
		const finish = (completion, value) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) input.clearTimer(timer);
			completion(value);
		};
		const timer = input.setTimer(
			() => {
				const error = new TypeError(
					`worker qualification ${input.scenarioId} exceeded harness deadline`,
				);
				controller.abort(error);
				finish(reject, error);
			},
			Math.max(0, input.deadline - input.now()),
		);
		Promise.resolve()
			.then(() => input.run(controller.signal))
			.then(
				(value) => finish(resolve, value),
				(error) => finish(reject, error),
			);
	});
}
