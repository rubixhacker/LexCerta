import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RELEASE_REPOSITORY, readGitHubReleaseJson } from "./release-github.mjs";
export { RELEASE_REPOSITORY };

// This is a read-only prerequisite check, not a grant of deployment approval.
export function assessReleaseProtection(branch, environment, policies) {
	const missing = [];
	if (branch?.name !== "main" || branch.protected !== true) missing.push("main_branch_protection");
	if (environment?.name?.toLowerCase() !== "production") missing.push("production_environment");
	const reviewers = environment?.protection_rules?.find(
		(rule) => rule.type === "required_reviewers",
	)?.reviewers;
	if (
		!Array.isArray(reviewers) ||
		reviewers.length !== 1 ||
		reviewers[0]?.type !== "User" ||
		reviewers[0]?.reviewer?.id !== 1776138
	)
		missing.push("production_owner_review");
	if (environment?.can_admins_bypass !== false) missing.push("production_bypass_disabled");
	const policy = environment?.deployment_branch_policy;
	const protectedOnly =
		policy?.protected_branches === true && policy.custom_branch_policies === false;
	const mainOnly =
		policy?.protected_branches === false &&
		policy.custom_branch_policies === true &&
		policies?.total_count === 1 &&
		policies.branch_policies?.length === 1 &&
		policies.branch_policies[0]?.name === "main" &&
		policies.branch_policies[0]?.type === "branch";
	if (!protectedOnly && !mainOnly) missing.push("production_branch_restriction");
	return { protection_ready: missing.length === 0, missing };
}

export async function inspectReleaseProtection({ token, request = fetch }) {
	const read = (path) => readGitHubReleaseJson(path, { token, request });
	try {
		const branch = await read("branches/main");
		const environment = await read("environments/production");
		const policies = environment?.deployment_branch_policy?.custom_branch_policies
			? await read("environments/production/deployment-branch-policies?per_page=100")
			: null;
		return {
			repository: RELEASE_REPOSITORY,
			observed_at: new Date().toISOString(),
			...assessReleaseProtection(branch, environment, policies),
			approval_granted: false,
		};
	} catch {
		throw new Error("Release protection inspection unavailable");
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		if (process.argv.length !== 4 || process.argv[2] !== "--output")
			throw new Error("Provide --output and a fresh protection report path");
		const report = await inspectReleaseProtection({ token: process.env.GH_TOKEN });
		await writeFile(process.argv[3], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
		console.log(JSON.stringify(report));
		if (!report.protection_ready) process.exitCode = 1;
	} catch {
		console.error("Release protection inspection unavailable; no deployment is authorized");
		process.exitCode = 1;
	}
}
