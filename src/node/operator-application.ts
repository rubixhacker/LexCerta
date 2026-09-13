import { createHmac, randomBytes } from "node:crypto";
import { z } from "zod";
import type { PgDatabase } from "../postgres/database.js";
import { KeyAdministrationConflict, PostgresKeyAdministration } from "../postgres/keys.js";
import type { RecoveryJournalWriter } from "../postgres/recovery-journal.js";
import { PostgresSourceAdministration } from "../postgres/source-administration.js";
import type { EvidenceRequest } from "../verification/evidence-request.js";
import { HttpBodyUnavailableError, readHttpJson } from "./http-body.js";
import { type OperatorIdentity, OperatorIdentityUnavailable } from "./operator-identity.js";
import { PilotCustomerId } from "./runtime-config.js";

const NewId = z.uuid().refine((id) => id === id.toLowerCase());
const Limits = z.strictObject({
	minute: z.number().int().min(1).max(600),
	day: z.number().int().min(1).max(10_000),
});
const Issue = z.strictObject({
	publicId: NewId,
	customerId: PilotCustomerId,
	limits: Limits.optional(),
});
const Rotate = z.strictObject({ publicId: NewId });
const Empty = z.strictObject({});

export function createOperatorRequestHandler(options: {
	readonly database: PgDatabase;
	readonly journal: RecoveryJournalWriter;
	readonly identity: OperatorIdentity;
	readonly environment: "production" | "test";
	readonly pepper: string;
	readonly customers: readonly string[];
}) {
	return async (request: Request, scope: EvidenceRequest): Promise<Response> => {
		let sourceRemoval = false;
		try {
			const subject = await options.identity(
				request.headers.get("x-lexcerta-operator-token"),
				scope.signal,
			);
			if (subject === null) return reply(401, { error: "unauthorized" });
			scope.checkpoint();
			const path = new URL(request.url).pathname;
			const store = new PostgresKeyAdministration(
				options.database.withSignal(scope.signal),
				options.environment,
				options.journal,
				scope.signal,
			);
			const statusId = /^\/v1\/keys\/([A-Za-z0-9-]{1,64})$/.exec(path)?.[1];
			if (request.method === "GET" && statusId !== undefined) {
				const result = await store.status(statusId);
				return result === null ? reply(404, { error: "not_found" }) : reply(200, result);
			}
			if (
				!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
					request.headers.get("content-type") ?? "",
				)
			)
				return reply(415, { error: "json_required" });
			let body: unknown;
			try {
				body = await readHttpJson(
					new Response(request.body, { headers: request.headers }),
					4096,
					scope.signal,
				);
			} catch (error) {
				scope.checkpoint();
				return reply(error instanceof HttpBodyUnavailableError ? 413 : 400, {
					error: "invalid_request",
				});
			}
			const sourceId = /^\/v1\/sources\/([1-9][0-9]{0,15})\/remove$/.exec(path)?.[1];
			if (request.method === "POST" && sourceId !== undefined) {
				Empty.parse(body);
				sourceRemoval = true;
				const sourceStore = new PostgresSourceAdministration(
					options.database.withSignal(scope.signal),
					options.environment,
					options.journal,
					scope.signal,
				);
				return reply(200, await sourceStore.remove(Number(sourceId), subject));
			}
			const match = /^\/v1\/keys\/([A-Za-z0-9-]{1,64})\/(rotate|revoke|limits)$/.exec(path);
			if (request.method === "POST" && path === "/v1/keys") {
				const input = Issue.parse(body);
				if (!options.customers.includes(input.customerId))
					return reply(403, { error: "customer_not_enrolled" });
				const material = credential(input.publicId, options.environment, options.pepper);
				scope.checkpoint();
				const result = await store.issue({
					publicId: input.publicId,
					customerId: input.customerId,
					environment: options.environment,
					hmacSha256Hex: material.digest,
					actorSubject: subject,
					minuteLimit: input.limits?.minute ?? 10,
					dayLimit: input.limits?.day ?? 100,
				});
				return reply(201, {
					publicId: input.publicId,
					credential: material.token,
					expiresAt: result.expiresAt.toISOString(),
				});
			}
			if (match?.[1] !== undefined) {
				const publicId = match[1];
				const action = match[2];
				if (action === "rotate" && request.method === "POST") {
					const input = Rotate.parse(body);
					const material = credential(input.publicId, options.environment, options.pepper);
					scope.checkpoint();
					const result = await store.rotate(publicId, {
						publicId: input.publicId,
						hmacSha256Hex: material.digest,
						actorSubject: subject,
					});
					return reply(201, {
						publicId: input.publicId,
						credential: material.token,
						expiresAt: result.expiresAt.toISOString(),
					});
				}
				if (action === "revoke" && request.method === "POST") {
					Empty.parse(body);
					await store.revoke(publicId, subject);
					return reply(200, { publicId, status: "revoked" });
				}
				if (action === "limits" && request.method === "PUT") {
					const limits = Limits.parse(body);
					await store.changeLimits(publicId, subject, limits.minute, limits.day);
					return reply(200, { publicId, limits });
				}
			}
			return reply(404, { error: "not_found" });
		} catch (error) {
			if (error instanceof z.ZodError) return reply(400, { error: "invalid_request" });
			if (error instanceof OperatorIdentityUnavailable)
				return reply(503, { error: "identity_unavailable" });
			if (
				error instanceof KeyAdministrationConflict ||
				(error instanceof Error && "code" in error && error.code === "23505")
			)
				return reply(409, {
					error: "key_conflict",
					recovery: "revoke_public_id_before_replacement",
				});
			// Includes lost COMMIT acknowledgements. Do not retry, return SQL errors,
			// or suggest the operation definitely failed: the mutation may have committed.
			return reply(503, {
				error: "outcome_unknown",
				recovery: sourceRemoval ? "repeat_source_removal" : "reconcile_public_id_before_retry",
			});
		}
	};
}

function credential(publicId: string, environment: "production" | "test", pepper: string) {
	const token = `lc_${environment === "production" ? "live" : "test"}_${publicId}_${randomBytes(32).toString("base64url")}`;
	return { token, digest: createHmac("sha256", pepper).update(token).digest("hex") };
}

function reply(status: number, body: unknown): Response {
	return Response.json(body, {
		status,
		headers: {
			"cache-control": "no-store",
			pragma: "no-cache",
			"x-content-type-options": "nosniff",
		},
	});
}
