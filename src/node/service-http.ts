import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EvidenceRequest, EvidenceRequestFailure } from "../verification/evidence-request.js";
import { readHttpBody } from "./http-body.js";

export type HttpRequestHandler = (request: Request, evidence: EvidenceRequest) => Promise<Response>;

export function createServiceHttpServer(
	handle: HttpRequestHandler,
	options: {
		readonly build: string;
		readonly profile: "public" | "operator";
		readonly timeoutMs?: number;
		readonly drainMs?: number;
	},
) {
	const operator = options.profile === "operator";
	const maximumTimeout = operator ? 10_000 : 55_000;
	const timeout = options.timeoutMs ?? maximumTimeout;
	const drainMs = options.drainMs ?? 9000;
	if (
		!Number.isSafeInteger(timeout) ||
		timeout < 1 ||
		timeout > maximumTimeout ||
		!Number.isSafeInteger(drainMs) ||
		drainMs < 1 ||
		drainMs > 9000
	)
		throw new Error("Invalid HTTP runtime bounds");
	const active = new Set<EvidenceRequest>();
	let draining = false;
	let closing: Promise<void> | undefined;
	const server = createServer(
		{
			maxHeaderSize: operator ? 16_384 : 8192,
			requestTimeout: maximumTimeout,
			headersTimeout: 10_000,
			connectionsCheckingInterval: 1000,
			keepAliveTimeout: 5000,
		},
		(incoming, outgoing) => {
			void respond(incoming, outgoing);
		},
	);
	server.maxConnections = operator ? 8 : 32;
	server.setTimeout(maximumTimeout, (socket) => socket.destroy());
	server.on("clientError", (_error, socket) =>
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"),
	);
	server.on("upgrade", (_request, socket) => socket.destroy());
	server.on("checkContinue", (_request, response) => reject(response, 417));
	server.on("checkExpectation", (_request, response) => reject(response, 417));

	async function respond(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
		if (draining) return reject(outgoing, 503);
		if (incoming.method === "GET" && incoming.url === "/healthz") {
			outgoing.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store",
				connection: "close",
			});
			outgoing.end(JSON.stringify({ status: "ok", build: options.build }));
			return;
		}
		const expectedMethod = routeMethod(incoming.url ?? "", operator);
		if (expectedMethod === undefined) return reject(outgoing, 404);
		if (incoming.headers.origin !== undefined) return reject(outgoing, 403);
		if (incoming.method !== expectedMethod) return reject(outgoing, 405, { allow: expectedMethod });
		if (duplicateBoundaryHeader(incoming)) return reject(outgoing, 400);
		if (active.size >= (operator ? 2 : 8)) return reject(outgoing, 503, { "retry-after": "1" });
		const evidence = new EvidenceRequest({ timeoutMs: timeout });
		active.add(evidence);
		const abort = () => evidence.close();
		const stopInput = () => incoming.destroy();
		incoming.once("aborted", abort);
		outgoing.once("close", abort);
		// Receiving headers starts the deadline; auth and body upload use it too.
		try {
			const headers = new Headers();
			for (const [name, value] of Object.entries(incoming.headers)) {
				if (value !== undefined && !["host", "connection", "transfer-encoding"].includes(name))
					headers.set(name, Array.isArray(value) ? value.join(", ") : value);
			}
			const init = {
				method: expectedMethod,
				headers,
				...(expectedMethod === "GET" ? {} : { body: incomingBody(incoming) }),
				signal: evidence.signal,
				duplex: "half" as const,
			};
			const request = new Request(`http://lexcerta.internal${incoming.url}`, init);
			const response = await evidence.run(() => handle(request, evidence));
			const bytes = await evidence.run(() =>
				readHttpBody(response, operator ? 16_384 : 1_048_576, evidence.signal),
			);
			evidence.checkpoint();
			if (outgoing.destroyed) return;
			for (const [name, value] of response.headers) {
				if (!["connection", "transfer-encoding", "content-length", "set-cookie"].includes(name))
					outgoing.setHeader(name, value);
			}
			outgoing.setHeader("cache-control", "no-store");
			outgoing.setHeader("content-length", bytes.byteLength);
			if (draining || !incoming.readableEnded) outgoing.setHeader("connection", "close");
			outgoing.statusCode = response.status;
			await evidence.run(
				() =>
					new Promise<void>((resolve) => {
						outgoing.once("finish", resolve);
						outgoing.end(bytes);
					}),
			);
		} catch (error) {
			if (!outgoing.destroyed && !outgoing.headersSent)
				reject(
					outgoing,
					error instanceof EvidenceRequestFailure && error.reason === "timeout" ? 504 : 503,
				);
			else if (!outgoing.writableFinished) outgoing.destroy();
		} finally {
			incoming.removeListener("aborted", abort);
			outgoing.removeListener("close", abort);
			evidence.close();
			active.delete(evidence);
			if (!incoming.readableEnded) {
				if (outgoing.writableFinished || outgoing.destroyed) stopInput();
				else outgoing.once("finish", stopInput);
			}
		}
	}

	return {
		server,
		get state() {
			return { active: active.size, draining };
		},
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			draining = true;
			closing = new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					for (const request of active) request.close();
					server.closeAllConnections();
				}, drainMs);
				server.close(() => {
					clearTimeout(timer);
					resolve();
				});
			});
			return closing;
		},
	};
}

function reject(
	response: ServerResponse,
	status: number,
	headers: Record<string, string> = {},
): void {
	response.writeHead(status, {
		...headers,
		"cache-control": "no-store",
		connection: "close",
		"content-length": "0",
	});
	response.end();
}

function duplicateBoundaryHeader(request: IncomingMessage): boolean {
	const seen = new Set<string>();
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		const name = request.rawHeaders[index]?.toLowerCase();
		if (
			name === undefined ||
			![
				"authorization",
				"x-serverless-authorization",
				"x-lexcerta-operator-token",
				"origin",
				"content-type",
				"content-length",
				"host",
				"mcp-protocol-version",
				"mcp-method",
				"mcp-name",
			].includes(name)
		)
			continue;
		if (seen.has(name)) return true;
		seen.add(name);
	}
	return false;
}

function incomingBody(incoming: IncomingMessage): ReadableStream<Uint8Array> {
	const iterator = incoming.iterator({ destroyOnReturn: false });
	let cancelled = false;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const chunk = await iterator.next();
					if (cancelled) return;
					if (chunk.done) controller.close();
					else controller.enqueue(chunk.value);
				} catch (error) {
					if (!cancelled) controller.error(error);
				}
			},
			cancel() {
				cancelled = true;
				incoming.pause();
				// A body-limit rejection must send its 413 response before closing
				// the socket. The HTTP completion path owns socket destruction.
				void iterator.return?.().catch(() => undefined);
			},
		},
		{ highWaterMark: 0 },
	);
}

function routeMethod(path: string, operator: boolean): "POST" | "PUT" | "GET" | undefined {
	if (!operator) return path === "/" ? "POST" : undefined;
	if (/^\/v1\/sources\/[1-9][0-9]{0,15}\/remove$/.test(path)) return "POST";
	if (path === "/v1/keys" || /^\/v1\/keys\/[A-Za-z0-9-]{1,64}\/(?:rotate|revoke)$/.test(path))
		return "POST";
	if (/^\/v1\/keys\/[A-Za-z0-9-]{1,64}\/limits$/.test(path)) return "PUT";
	if (/^\/v1\/keys\/[A-Za-z0-9-]{1,64}$/.test(path)) return "GET";
	return undefined;
}
