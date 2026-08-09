import type { AuthEnvironment } from "./auth/api-key.js";
import type { CourtListenerCoordinatorRpc } from "./courtlistener/coordinator.js";

import { runScheduledRetention } from "./retention/scheduled-retention.js";
import { recordResponseTelemetry, telemetryTool } from "./telemetry/runtime.js";
import { respondToRequest } from "./worker-request.js";

export { ApiKeyLimiter } from "./admission/api-key-limiter.js";
export { CourtListenerCoordinator } from "./courtlistener/coordinator.js";

type AdmissionInput = { readonly admittedAt: number; readonly publicId: string };

type AdmissionResult =
	| { readonly kind: "allowed" }
	| { readonly kind: "exhausted"; readonly retryAfterSeconds: number };

interface ApiKeyLimiterStub {
	admit(input: AdmissionInput): Promise<AdmissionResult>;
}

interface ApiKeyLimiterNamespace {
	getByName(name: string): ApiKeyLimiterStub;
}

interface CourtListenerCoordinatorNamespace {
	getByName(name: string): CourtListenerCoordinatorRpc;
}

type CourtListenerEnvironment = {
	readonly COURTLISTENER_API_TOKEN?: string;
	readonly COURTLISTENER_COORDINATOR?: CourtListenerCoordinatorNamespace;
	readonly COURTLISTENER_CREDENTIAL_ID?: string;
	readonly OPINION_CACHE?: R2Bucket;
};

export type Env = {
	readonly BUILD_ID: string;
	readonly DB: D1Database;
	readonly API_KEY_LIMITER: ApiKeyLimiterNamespace;
	readonly TELEMETRY?: AnalyticsEngineDataset;
} & AuthEnvironment &
	CourtListenerEnvironment;

const worker = {
	async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "GET" && pathname === "/healthz") {
			return Response.json({ status: "ok", build: env.BUILD_ID });
		}
		const startedAt = performance.now();
		const completion = await respondToRequest(request, env, pathname);
		const telemetry = env.TELEMETRY;
		if (
			pathname === "/" &&
			request.method === "POST" &&
			context !== undefined &&
			telemetry !== undefined
		) {
			recordResponseTelemetry({
				boundaryOutcome: completion.boundaryOutcome,
				context,
				environment: { TELEMETRY: telemetry },
				keyIdentifier: null,
				response: completion.response,
				startedAt,
				tool: telemetryTool(request),
			});
		}
		return completion.response;
	},
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		await runScheduledRetention(env.DB, new Date(controller.scheduledTime));
	},
} satisfies ExportedHandler<Env>;

export default worker;
