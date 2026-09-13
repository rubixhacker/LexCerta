import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeSync } from "node:fs";
import { z } from "zod";
import { EvidenceRequest } from "../verification/evidence-request.js";
import { readHttpJson } from "./http-body.js";
import { OperatorAudience, PilotCustomerId } from "./runtime-config.js";

const PublicId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
const PositiveInteger = z
	.string()
	.regex(/^[1-9]\d*$/)
	.transform(Number);
const Minute = PositiveInteger.pipe(z.number().int().max(600));
const Day = PositiveInteger.pipe(z.number().int().max(10_000));
const Invoker = z
	.string()
	.regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/);

type Invocation =
	| {
			readonly action: "issue" | "rotate" | "revoke" | "limits" | "status";
			readonly publicId: string;
			readonly path: string;
			readonly body: unknown;
	  }
	| {
			readonly action: "remove-source";
			readonly opinionId: number;
			readonly path: string;
			readonly body: unknown;
	  };

function command(args: readonly string[]): Invocation {
	const [action, target, minute, day] = args;
	if (action === "remove-source" && args.length === 2) {
		const opinionId = PositiveInteger.pipe(z.number().int().positive().safe()).parse(target);
		return { action, opinionId, path: `/v1/sources/${opinionId}/remove`, body: {} };
	}
	if (action === "issue" && (args.length === 2 || args.length === 4)) {
		const customerId = PilotCustomerId.parse(target);
		const publicId = randomUUID();
		const limits =
			args.length === 4 ? { minute: Minute.parse(minute), day: Day.parse(day) } : undefined;
		return {
			action,
			publicId,
			path: "/v1/keys",
			body: { publicId, customerId, ...(limits ? { limits } : {}) },
		};
	}
	if ((action === "rotate" || action === "revoke") && args.length === 2) {
		const priorId = PublicId.parse(target);
		const publicId = action === "rotate" ? randomUUID() : priorId;
		return {
			action,
			publicId,
			path: `/v1/keys/${priorId}/${action}`,
			body: action === "rotate" ? { publicId } : {},
		};
	}
	if (action === "status" && args.length === 2) {
		const publicId = PublicId.parse(target);
		return { action, publicId, path: `/v1/keys/${publicId}`, body: undefined };
	}
	if (action === "limits" && args.length === 4) {
		const publicId = PublicId.parse(target);
		return {
			action,
			publicId,
			path: `/v1/keys/${publicId}/limits`,
			body: { minute: Minute.parse(minute), day: Day.parse(day) },
		};
	}
	throw new Error("Invalid operator command");
}

export async function gcloudOperatorToken(
	audience: string,
	invoker: string,
	signal: AbortSignal,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"gcloud",
			[
				"auth",
				"print-identity-token",
				`--impersonate-service-account=${Invoker.parse(invoker)}`,
				`--audiences=${OperatorAudience.parse(audience)}`,
				"--quiet",
			],
			{
				signal,
				timeout: 10_000,
				killSignal: "SIGKILL",
				maxBuffer: 4096,
				encoding: "utf8",
			},
			(error, stdout) => {
				const token = stdout.trim();
				if (
					error ||
					signal.aborted ||
					token.length > 4096 ||
					!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
				)
					reject(new Error("Operator credential unavailable"));
				else resolve(token);
			},
		);
	});
}

// stdout is reserved for the one-time result. Neither request credentials nor
// provider/server error bodies are included in diagnostics. No mutation retries.
export async function runOperatorCommand(
	args: readonly string[],
	environment: NodeJS.ProcessEnv,
	output: { result(value: string): void; diagnostic(value: string): void },
	dependencies: {
		readonly token?: typeof gcloudOperatorToken;
		readonly transport?: typeof fetch;
	} = {},
): Promise<number> {
	let invocation: Invocation;
	let audience: string;
	let invoker: string;
	try {
		invocation = command(args);
		const { LEXCERTA_OPERATOR_URL, LEXCERTA_OPERATOR_INVOKER } = environment;
		audience = OperatorAudience.parse(LEXCERTA_OPERATOR_URL);
		invoker = Invoker.parse(LEXCERTA_OPERATOR_INVOKER);
	} catch {
		output.diagnostic(
			"Set LEXCERTA_OPERATOR_URL and LEXCERTA_OPERATOR_INVOKER. Commands: issue CUSTOMER [MINUTE DAY], rotate PUBLIC_ID, revoke PUBLIC_ID, limits PUBLIC_ID MINUTE DAY, status PUBLIC_ID, remove-source OPINION_ID.\n",
		);
		return 2;
	}
	const target =
		invocation.action === "remove-source"
			? `opinion ID: ${invocation.opinionId}`
			: `public ID: ${invocation.publicId}`;
	output.diagnostic(`Prepared ${invocation.action}; ${target}\n`);
	const scope = new EvidenceRequest({ timeoutMs: 25_000 });
	let dispatched = false;
	try {
		const token = await scope.run(() =>
			(dependencies.token ?? gcloudOperatorToken)(audience, invoker, scope.signal),
		);
		const request = new EvidenceRequest({ signal: scope.signal, timeoutMs: 10_000 });
		try {
			dispatched = true;
			const response = await request.run(() =>
				(dependencies.transport ?? fetch)(`${audience}${invocation.path}`, {
					method:
						invocation.action === "status"
							? "GET"
							: invocation.action === "limits"
								? "PUT"
								: "POST",
					redirect: "manual",
					signal: request.signal,
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${token}`,
						// Cloud Run may strip the platform Authorization signature. The
						// application verifies this separately supplied full token itself.
						"x-lexcerta-operator-token": token,
					},
					...(invocation.action === "status" ? {} : { body: JSON.stringify(invocation.body) }),
				}),
			);
			if (invocation.action === "status" && response.status === 404) {
				// Only the authenticated application's exact response establishes
				// absence. An IAM/proxy error or unreadable response does not.
				z.strictObject({ error: z.literal("not_found") }).parse(
					await readHttpJson(response, 16_384, request.signal),
				);
				request.checkpoint();
				output.result(`${JSON.stringify({ publicId: invocation.publicId, status: "absent" })}\n`);
				return 0;
			}
			if (
				response.status !==
				(invocation.action === "issue" || invocation.action === "rotate" ? 201 : 200)
			) {
				void response.body?.cancel().catch(() => undefined);
				throw new Error("Operator request unsuccessful");
			}
			const decoded = await readHttpJson(response, 16_384, request.signal);
			let result: unknown;
			if (invocation.action === "issue" || invocation.action === "rotate") {
				const issued = z
					.strictObject({
						publicId: z.literal(invocation.publicId),
						credential: z.string().max(128),
						expiresAt: z.iso.datetime(),
					})
					.parse(decoded);
				if (
					!new RegExp(`^lc_(?:live|test)_${invocation.publicId}_[A-Za-z0-9_-]{43}$`).test(
						issued.credential,
					)
				)
					throw new Error("Invalid credential response");
				result = issued;
			} else if (invocation.action === "remove-source") {
				result = z
					.strictObject({
						opinionId: z.literal(invocation.opinionId),
						status: z.literal("removed"),
						removedAt: z.iso.datetime(),
						pendingDeletionObjects: z.number().int().nonnegative().safe(),
					})
					.parse(decoded);
			} else if (invocation.action === "status") {
				result = z
					.strictObject({
						publicId: z.literal(invocation.publicId),
						customerId: PilotCustomerId,
						status: z.enum(["active", "revoked"]),
						expiresAt: z.iso.datetime(),
						limits: z.strictObject({
							minute: z.number().int().min(1).max(600),
							day: z.number().int().min(1).max(10_000),
						}),
					})
					.parse(decoded);
			} else if (invocation.action === "revoke") {
				result = z
					.strictObject({ publicId: z.literal(invocation.publicId), status: z.literal("revoked") })
					.parse(decoded);
			} else {
				result = z
					.strictObject({
						publicId: z.literal(invocation.publicId),
						limits: z.strictObject({
							minute: z.number().int().min(1).max(600),
							day: z.number().int().min(1).max(10_000),
						}),
					})
					.parse(decoded);
				if (
					JSON.stringify((result as { limits: unknown }).limits) !== JSON.stringify(invocation.body)
				)
					throw new Error("Invalid limits response");
			}
			request.checkpoint();
			output.result(`${JSON.stringify(result)}\n`);
			return 0;
		} finally {
			request.close();
		}
	} catch {
		output.diagnostic(
			invocation.action === "status"
				? "Status could not be read; no mutation was sent.\n"
				: dispatched && invocation.action === "remove-source"
					? `The removal may have committed. Repeat remove-source ${invocation.opinionId} to reconcile it; this cannot restore the source.\n`
					: dispatched && invocation.action !== "remove-source"
						? `No automatic retry. The operation may have committed. ${invocation.action === "issue" || invocation.action === "rotate" ? "Revoke" : "Reconcile"} public ID ${invocation.publicId} before replacement or retry; secrets cannot be recovered.\n`
						: "Operator identity could not be obtained; no mutation was sent.\n",
		);
		return 1;
	} finally {
		scope.close();
	}
}

if (import.meta.main) {
	process.exitCode = await runOperatorCommand(process.argv.slice(2), process.env, {
		result: (value) => {
			writeSync(1, value);
		},
		diagnostic: (value) => {
			writeSync(2, value);
		},
	});
}
