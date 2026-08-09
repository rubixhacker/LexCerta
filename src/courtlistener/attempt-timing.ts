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
		return await transport(request);
	} catch {
		return request.signal.aborted ? "timeout" : "transport";
	} finally {
		if (startedAt !== undefined) timing?.recordDuration(timing.monotonicNow() - startedAt);
	}
}
