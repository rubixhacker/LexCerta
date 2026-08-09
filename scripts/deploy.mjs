import { fileURLToPath } from "node:url";

const rejectedWorkerDeploymentMessage =
	"Cloudflare Worker deployment is disabled after Issue #10 rejected its memory qualification. " +
	"Deploy only after Cloud Run delivery in Issue #11 replaces this command.";

if (isDeployEntrypoint()) {
	console.error(rejectedWorkerDeploymentMessage);
	process.exitCode = 1;
}

export function createWorkerDeploymentPlan(suppliedArguments) {
	const explicitEnvironmentArguments = extractEnvironmentArguments(suppliedArguments);
	const deploymentEnvironmentArguments =
		explicitEnvironmentArguments.length === 0 ? ["--env="] : [];
	const migrationEnvironmentArguments =
		explicitEnvironmentArguments.length === 0 ? ["--env="] : explicitEnvironmentArguments;

	return {
		publicDeployment: ["deploy", ...deploymentEnvironmentArguments, ...suppliedArguments],
		remoteMigration: [
			"d1",
			"migrations",
			"apply",
			"DB",
			"--remote",
			"--config",
			"wrangler.jsonc",
			...migrationEnvironmentArguments,
		],
		skipRemoteMigration: isDryRun(suppliedArguments),
		telemetryDeployment: [
			"deploy",
			"--config",
			"wrangler.telemetry.jsonc",
			...deploymentEnvironmentArguments,
			...suppliedArguments,
		],
	};
}

function isDeployEntrypoint() {
	return process.argv[1] === fileURLToPath(import.meta.url);
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
