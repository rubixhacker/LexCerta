import { z } from "zod";
import {
	type CourtListenerAttemptFailure,
	type CourtListenerAttemptTiming,
	type CourtListenerAttemptTransport,
	sendCourtListenerRequest,
} from "./attempt-timing.js";

const MAX_RETRY_AFTER_SECONDS = 604_800;

export type CaseLawTransport = CourtListenerAttemptTransport;
export type CaseLawTransportFailure = CourtListenerAttemptFailure;

export function retryAfterSeconds(value: string | null, now: () => Date): number | undefined {
	if (value === null) return undefined;
	const header = z.string().trim().safeParse(value);
	if (!header.success) return undefined;
	if (/^\d+$/.test(header.data)) {
		const seconds = Number(header.data);
		return Number.isSafeInteger(seconds) && seconds <= MAX_RETRY_AFTER_SECONDS
			? seconds
			: undefined;
	}
	const retryAt = Date.parse(header.data);
	if (!Number.isFinite(retryAt)) return undefined;
	const seconds = Math.max(0, Math.ceil((retryAt - now().getTime()) / 1_000));
	return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : undefined;
}

export function signalFor(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

export async function send(
	transport: CaseLawTransport,
	request: Request,
	timing?: CourtListenerAttemptTiming,
): Promise<Response | CaseLawTransportFailure> {
	return sendCourtListenerRequest(transport, request, timing);
}
