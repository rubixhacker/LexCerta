import type { CourtListenerDataEndpoint, QuotaWindow } from "./budget-state.js";

export function reapplyCapturedDataDebits(
	windows: readonly QuotaWindow[],
	endpoints: readonly CourtListenerDataEndpoint[],
): readonly QuotaWindow[] {
	return windows.map((window) => {
		const debits = endpoints.filter((endpoint) => appliesTo(window.scope, endpoint)).length;
		return debits === 0 ? window : { ...window, remaining: Math.max(0, window.remaining - debits) };
	});
}

function appliesTo(scope: string, endpoint: CourtListenerDataEndpoint): boolean {
	return scope === "user" || (scope === "citations" && endpoint === "citation");
}
