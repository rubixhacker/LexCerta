import { randomUUID } from "node:crypto";
import { type CourtListenerTransport, createCourtListenerApi } from "../courtlistener/api.js";
import { createCourtListenerCaseLawApi } from "../courtlistener/case-law-api.js";
import { createCourtListenerCaseLawGateway } from "../courtlistener/case-law-gateway.js";
import { createCourtListenerCitationGateway } from "../courtlistener/gateway.js";
import { createLexCertaMcpHandler, protocolBoundaryRejection } from "../mcp.js";
import { createPostgresCitationStore } from "../postgres/citations.js";
import { PostgresCourtListenerCoordinator } from "../postgres/coordinator.js";
import type { PgDatabase } from "../postgres/database.js";
import { PostgresKeyAdmission } from "../postgres/keys.js";
import type { SourceObjects } from "../postgres/objects.js";
import { PostgresOpinionSources } from "../postgres/opinions.js";
import { MAX_MCP_REQUEST_BODY_BYTES } from "../request-body.js";
import { createCachedCitationGateway } from "../verification/cached-citation-gateway.js";
import { EvidenceRequest } from "../verification/evidence-request.js";
import type { OpinionNormalizer } from "../verification/quote-normalization.js";
import { HttpBodyUnavailableError, readHttpBody, readHttpJson } from "./http-body.js";
import type { PublicRequestHandler } from "./public-http.js";

type PublicDependencies = {
	readonly database: PgDatabase;
	readonly objects: (signal: AbortSignal) => SourceObjects;
	readonly normalize: OpinionNormalizer;
	readonly environment: "test" | "production";
	readonly pepper: string;
	readonly credentialId: string;
	readonly upstreamToken: string;
	readonly transport?: CourtListenerTransport;
};

export function createPublicRequestHandler(options: PublicDependencies): PublicRequestHandler {
	return async (incoming, request) => {
		const database = options.database.withSignal(request.signal);
		const admission = await new PostgresKeyAdmission(
			database,
			options.pepper,
			options.environment,
		).admit(incoming.headers.get("authorization"));
		if (admission.kind === "unauthorized")
			return new Response(null, { status: 401, headers: { "www-authenticate": "Bearer" } });
		if (admission.kind === "exhausted")
			return exhausted(incoming, admission.retryAfterSeconds, request.signal);
		let bounded: Request;
		try {
			const bytes = await readHttpBody(
				new Response(incoming.body, { headers: incoming.headers }),
				MAX_MCP_REQUEST_BODY_BYTES,
				request.signal,
			);
			new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			bounded = new Request(incoming, { body: new Uint8Array(bytes) });
		} catch (error) {
			request.checkpoint();
			return new Response(null, { status: error instanceof HttpBodyUnavailableError ? 413 : 400 });
		}
		const rejection = await protocolBoundaryRejection(bounded);
		if (rejection !== undefined) return rejection;
		const coordinator = new PostgresCourtListenerCoordinator(database, options.credentialId);
		const now = () => new Date();
		const apiOptions = {
			request,
			token: options.upstreamToken,
			transport: options.transport ?? ((source: Request) => fetch(source)),
		};
		const api = createCourtListenerApi(apiOptions);
		const citation = createCachedCitationGateway({
			request,
			store: createPostgresCitationStore(database),
			now,
			ownerToken: randomUUID,
			upstream: createCourtListenerCitationGateway({ api, coordinator, now, token: randomUUID }),
		});
		const quote = createCourtListenerCaseLawGateway({
			request,
			api: createCourtListenerCaseLawApi(apiOptions),
			quotaApi: api,
			coordinator,
			now,
			token: randomUUID,
			opinions: new PostgresOpinionSources(database, options.objects(request.signal)),
		});
		return createLexCertaMcpHandler({
			request,
			citation,
			quote,
			normalize: options.normalize,
		}).fetch(bounded);
	};
}

async function exhausted(
	incoming: Request,
	retryAfterSeconds: number,
	signal: AbortSignal,
): Promise<Response> {
	const request = new EvidenceRequest({ signal, timeoutMs: 100 });
	let id: string | number | undefined;
	try {
		const value = await request.run(() =>
			readHttpJson(
				new Response(incoming.body, { headers: incoming.headers }),
				16_384,
				request.signal,
			),
		);
		if (typeof value === "object" && value !== null && "id" in value) {
			if (typeof value.id === "string" && value.id.length <= 256) id = value.id;
			else if (typeof value.id === "number" && Number.isSafeInteger(value.id)) id = value.id;
		}
	} catch {
		// A retry hint must not wait for an invalid or stalled request body.
	} finally {
		request.close();
	}
	return new Response(
		id === undefined
			? null
			: JSON.stringify({
					jsonrpc: "2.0",
					id,
					error: { code: 1001, message: "API key allowance exhausted" },
				}),
		{
			status: 429,
			headers: {
				"content-type": "application/json",
				"retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))),
			},
		},
	);
}
