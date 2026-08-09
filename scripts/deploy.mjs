import { spawnSync } from "node:child_process";

const suppliedArguments = process.argv.slice(2);
const explicitEnvironmentArguments = extractEnvironmentArguments(suppliedArguments);
const deploymentEnvironmentArguments = explicitEnvironmentArguments.length === 0 ? ["--env="] : [];
const migrationEnvironmentArguments =
	explicitEnvironmentArguments.length === 0 ? ["--env="] : explicitEnvironmentArguments;
const wranglerCommand = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const traceDeployment = [
	"deploy",
	"--config",
	"wrangler.telemetry.jsonc",
	...deploymentEnvironmentArguments,
	...suppliedArguments,
];
const migration = [
	"d1",
	"migrations",
	"apply",
	"DB",
	"--remote",
	"--config",
	"wrangler.jsonc",
	...migrationEnvironmentArguments,
];
const publicDeployment = ["deploy", ...deploymentEnvironmentArguments, ...suppliedArguments];

if (run(traceDeployment) && (!isDryRun(suppliedArguments) ? run(migration) : skipMigration())) {
	run(publicDeployment);
}

function run(argumentsForWrangler) {
	const result = spawnSync(wranglerCommand, argumentsForWrangler, { stdio: "inherit" });
	if (result.status === 0) return true;
	process.exitCode = result.status ?? 1;
	return false;
}

function skipMigration() {
	console.log("Skipping remote D1 migrations during --dry-run.");
	return true;
}

function extractEnvironmentArguments(argumentsToInspect) {
	const environment = [];
	for (let index = 0; index < argumentsToInspect.length; index += 1) {
		const argument = argumentsToInspect[index];
		if (argument === "-e" || argument === "--env") {
			environment.push(argument);
			const value = argumentsToInspect[index + 1];
			if (value !== undefined) {
				environment.push(value);
				index += 1;
			}
		} else if (argument.startsWith("-e=") || argument.startsWith("--env=")) {
			environment.push(argument);
		}
	}
	return environment;
}

function isDryRun(argumentsToInspect) {
	return argumentsToInspect.some(
		(argument) => argument === "--dry-run" || argument.startsWith("--dry-run="),
	);
}
