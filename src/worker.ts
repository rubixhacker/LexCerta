import {
	authenticateRequest,
	createAuthenticationFailureResponse,
	type AuthEnvironment,
} from "./auth/api-key.js";
import { mcpHandler, protocolBoundaryRejection } from "./mcp.js";

export type Env = {
	readonly BUILD_ID: string;
} & AuthEnvironment;

const worker = {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/healthz") {
			return Response.json({ status: "ok", build: env.BUILD_ID });
		}
		if (pathname === "/" && request.method !== "POST") {
			return new Response(null, { headers: { allow: "POST" }, status: 405 });
		}
		if (pathname === "/") {
			const authentication = await authenticateRequest(request, env);
			switch (authentication.kind) {
				case "authenticated": {
					const rejection = protocolBoundaryRejection(request);
					if (rejection !== undefined) return rejection;
					return mcpHandler.fetch(request);
				}
				case "unauthorized":
				case "unavailable":
					return createAuthenticationFailureResponse(authentication);
				default: {
					const unreachable: never = authentication;
					return unreachable;
				}
			}
		}
		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

export default worker;
