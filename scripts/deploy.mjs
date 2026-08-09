import { spawnSync } from "node:child_process";

const suppliedArguments = process.argv.slice(2);
const environmentArguments = hasEnvironmentArgument(suppliedArguments) ? [] : ["--env="];
const wranglerCommand = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const deploymentArguments = [
	["deploy", "--config", "wrangler.telemetry.jsonc", ...environmentArguments, ...suppliedArguments],
	["deploy", ...environmentArguments, ...suppliedArguments],
];

for (const argumentsForWorker of deploymentArguments) {
	const result = spawnSync(wranglerCommand, argumentsForWorker, { stdio: "inherit" });
	if (result.status !== 0) {
		process.exitCode = result.status ?? 1;
		break;
	}
}

function hasEnvironmentArgument(argumentsToInspect) {
	return argumentsToInspect.some(
		(argument) =>
			argument === "-e" ||
			argument === "--env" ||
			argument.startsWith("-e=") ||
			argument.startsWith("--env="),
	);
}
