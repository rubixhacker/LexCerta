import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const productionDependencies = ["@modelcontextprotocol/server", "parse5", "zod"];
const defaultOutdir = ".omo/evidence/issue-10/worker-artifact";
const outdir = resolve(process.argv[2] ?? defaultOutdir);
const manifestPath = join(outdir, "qualification-manifest.json");
const metafilePath = join(outdir, "bundle-meta.json");

requireTrackedWorktreeAtHead();

if (existsSync(outdir) && readdirSync(outdir).length > 0) {
	throw new Error(`Refusing to overwrite a non-empty qualification directory: ${outdir}`);
}
mkdirSync(outdir, { recursive: true });

run("./node_modules/.bin/wrangler", [
	"deploy",
	"--dry-run",
	"--env=",
	"--outdir",
	outdir,
	"--metafile",
	metafilePath,
]);

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const declared = Object.fromEntries(
	productionDependencies.map((dependency) => [dependency, packageJson.dependencies?.[dependency]]),
);
if (Object.values(declared).some((version) => typeof version !== "string")) {
	throw new Error("The qualification graph is missing a required production dependency.");
}

const artifactFiles = files(outdir)
	.filter((file) => basename(file) !== basename(manifestPath))
	.map((file) => ({
		bytes: statSync(file).size,
		path: relative(outdir, file),
		sha256: sha256(readFileSync(file)),
	}))
	.sort((left, right) => left.path.localeCompare(right.path));
const bundle = artifactFiles.find((file) => file.path.endsWith(".js"));
if (bundle === undefined) throw new Error("Wrangler did not emit a JavaScript Worker bundle.");

const manifest = {
	artifact: { bundle, files: artifactFiles },
	build: {
		commit: output("git", ["rev-parse", "HEAD"]),
		compatibilityDate: readConfigValue("wrangler.jsonc", "compatibility_date"),
		configurationSha256: sha256(readFileSync("wrangler.jsonc")),
		lockfileSha256: sha256(readFileSync("package-lock.json")),
	},
	productionDependencyGraph: {
		declared,
		resolved: JSON.parse(output("npm", ["ls", "--omit=dev", "--json", "--depth=0"])).dependencies,
	},
	runtime: {
		workerd: output("./node_modules/.bin/workerd", ["--version"]),
		wrangler: output("./node_modules/.bin/wrangler", ["--version"]),
	},
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
process.stdout.write(`${manifestPath}\n`);

function files(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = join(directory, entry.name);
		return entry.isDirectory() ? files(file) : [file];
	});
}

function output(command, args) {
	return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function requireTrackedWorktreeAtHead() {
	if (output("git", ["status", "--porcelain", "--untracked-files=no"]) !== "") {
		throw new Error("Refusing qualification because tracked files differ from HEAD.");
	}
}

function readConfigValue(file, property) {
	const source = readFileSync(file, "utf8");
	const match = new RegExp(`"${property}"\\s*:\\s*"([^"]+)"`).exec(source);
	if (match?.[1] === undefined) throw new Error(`Missing ${property} in ${file}.`);
	return match[1];
}

function run(command, args) {
	execFileSync(command, args, { stdio: "inherit" });
}

function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
