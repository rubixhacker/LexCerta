import { parentPort } from "node:worker_threads";

// Establish that this actual worker entered the CPU fault before the next job.
parentPort.once("message", ({ id }) => {
	parentPort.postMessage({ id, kind: "normalized", text: "CPU fault entered" });
	for (;;) {
		/* Deliberate qualification fault; parent must terminate us. */
	}
});
