export type CourtListenerAttemptTiming = {
	readonly monotonicNow: () => number;
	readonly recordDuration: (milliseconds: number) => void;
};

export type CourtListenerAttemptTransport = (request: Request) => Promise<Response>;
export type CourtListenerAttemptFailure = "timeout" | "transport";

export async function sendCourtListenerRequest(
	transport: CourtListenerAttemptTransport,
	request: Request,
	timing: CourtListenerAttemptTiming | undefined,
): Promise<Response | CourtListenerAttemptFailure> {
	const startedAt = timing?.monotonicNow();
	try {
		return await abortable(async () => {
			const response = await transport(request);
			if (request.signal.aborted) {
				discardResponse(response);
				throw request.signal.reason;
			}
			return response;
		}, request.signal);
	} catch {
		return request.signal.aborted ? "timeout" : "transport";
	} finally {
		if (startedAt !== undefined) timing?.recordDuration(timing.monotonicNow() - startedAt);
	}
}
import { abortable } from "../verification/evidence-request.js";
import { discardResponse } from "./response-body.js";
