import assert from "node:assert/strict";
import { test } from "node:test";
import { assessReleaseProtection, inspectReleaseProtection } from "./release-readiness.mjs";

const branch = { name: "main", protected: true };
const environment = {
	name: "Production",
	can_admins_bypass: false,
	protection_rules: [
		{ type: "required_reviewers", reviewers: [{ type: "User", reviewer: { id: 1776138 } }] },
	],
	deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
};

test("production requires protected main, the owner reviewer, no bypass and branch restrictions", () => {
	assert.deepEqual(assessReleaseProtection(branch, environment, null), {
		protection_ready: true,
		missing: [],
	});
	for (const [changedBranch, changedEnvironment, expected] of [
		[{ ...branch, protected: false }, environment, "main_branch_protection"],
		[branch, { ...environment, protection_rules: [] }, "production_owner_review"],
		[branch, { ...environment, can_admins_bypass: true }, "production_bypass_disabled"],
		[branch, { ...environment, can_admins_bypass: undefined }, "production_bypass_disabled"],
		[branch, { ...environment, deployment_branch_policy: null }, "production_branch_restriction"],
		[branch, null, "production_environment"],
	]) {
		const result = assessReleaseProtection(changedBranch, changedEnvironment, null);
		assert.equal(result.protection_ready, false);
		assert.ok(result.missing.includes(expected));
	}
});

test("custom deployment policies accept only the exact main branch, not tags or extra patterns", () => {
	const custom = {
		...environment,
		deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
	};
	const accepted = { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] };
	assert.equal(assessReleaseProtection(branch, custom, accepted).protection_ready, true);
	for (const policies of [
		null,
		{ ...accepted, total_count: 101 },
		{ total_count: 1, branch_policies: [{ name: "main", type: "tag" }] },
		{ total_count: 1, branch_policies: [{ name: "*", type: "branch" }] },
	])
		assert.equal(assessReleaseProtection(branch, custom, policies).protection_ready, false);
});

test("an extra reviewer cannot substitute another person's approval for the owner gate", () => {
	const changed = structuredClone(environment);
	changed.protection_rules[0].reviewers.push({ type: "User", reviewer: { id: 999 } });
	assert.equal(assessReleaseProtection(branch, changed, null).protection_ready, false);
});

test("live inspection uses only bounded reads on the fixed repository and never grants approval", async () => {
	const calls = [];
	const report = await inspectReleaseProtection({
		token: "synthetic-github-token",
		request: async (url, options) => {
			calls.push(url);
			assert.equal(options.method, "GET");
			assert.equal(options.redirect, "error");
			assert.ok(options.signal instanceof AbortSignal);
			assert.equal(options.headers.Authorization, "Bearer synthetic-github-token");
			return Response.json(url.endsWith("branches/main") ? branch : environment);
		},
	});
	assert.equal(report.protection_ready, true);
	assert.equal(report.approval_granted, false);
	assert.ok(!JSON.stringify(report).includes("synthetic-github-token"));
	assert.deepEqual(calls, [
		"https://api.github.com/repos/rubixhacker/LexCerta/branches/main",
		"https://api.github.com/repos/rubixhacker/LexCerta/environments/production",
	]);
});

test("missing, malformed and unavailable remote evidence cannot become ready or disclose provider errors", async () => {
	const missing = await inspectReleaseProtection({
		request: async () => new Response(null, { status: 404 }),
	});
	assert.equal(missing.protection_ready, false);
	for (const request of [
		async () => new Response("private-sentinel", { status: 403 }),
		async () => new Response("private-sentinel"),
		async () => new Response("x".repeat(262_145)),
		async () => {
			throw new Error("private-sentinel");
		},
	])
		await assert.rejects(inspectReleaseProtection({ request }), {
			message: "Release protection inspection unavailable",
		});
});
