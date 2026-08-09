import { createServer } from "node:net";

export async function runWithWorkerQualificationCleanup(input) {
	try {
		return await input.run();
	} finally {
		try {
			input.clearSampler();
		} finally {
			try {
				input.closeInspector();
			} finally {
				await input.terminateChild();
			}
		}
	}
}

export async function terminateChildProcess(child, exit, graceMilliseconds = 500) {
	if (child.exitCode !== null || child.pid === undefined) return exit;
	signal(child.pid, "SIGTERM");
	if (await Promise.race([exit.then(() => true), wait(graceMilliseconds)])) return;
	signal(child.pid, "SIGKILL");
	return exit;
}

export async function availableInspectorPort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new TypeError("missing inspector port");
	await new Promise((resolve) => server.close(resolve));
	return address.port;
}

function signal(pid, signalName) {
	try {
		process.kill(-pid, signalName);
	} catch (error) {
		if (error?.code !== "ESRCH") throw error;
	}
}

function wait(milliseconds) {
	return new Promise((resolve) => setTimeout(() => resolve(false), milliseconds));
}
