export interface ToolResponseEnvelope {
	valid: boolean;
	metadata: Record<string, unknown> | null;
	error: { code: string; message: string; details?: unknown } | null;
}

export function createToolResponse(envelope: ToolResponseEnvelope) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
	};
}
