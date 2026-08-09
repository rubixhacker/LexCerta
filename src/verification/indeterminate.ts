import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { CONTRACT_VERSION } from "./citation.js";

const citationInput = z
	.string()
	.min(1)
	.max(256)
	.describe("Case-law citation in volume reporter page form.");

export const verifyCitationInputSchema = z.object({ citation: citationInput }).strict();

export const verifyQuoteInputSchema = z
	.object({
		citation: citationInput,
		quote: z
			.string()
			.min(20)
			.max(10000)
			.describe("Quoted judicial text to verify without returning its contents."),
	})
	.strict();

export const verificationIndeterminateOutputSchema = z
	.object({
		outcome: z.literal("indeterminate"),
		contractVersion: z.literal(CONTRACT_VERSION),
		reason: z.literal("verification_not_available"),
	})
	.strict();

export type IndeterminateVerificationResult = z.infer<typeof verificationIndeterminateOutputSchema>;

const toolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
} as const;

export const verifyCitationToolDefinition = {
	title: "Verify citation",
	description: "Verify a supported case-law citation against LexCerta's evidence source.",
	inputSchema: verifyCitationInputSchema,
	outputSchema: verificationIndeterminateOutputSchema,
	annotations: { title: "Verify citation", ...toolAnnotations },
} as const;

export const verifyQuoteToolDefinition = {
	title: "Verify quote",
	description: "Verify quoted judicial text against evidence for a supported case-law citation.",
	inputSchema: verifyQuoteInputSchema,
	outputSchema: verificationIndeterminateOutputSchema,
	annotations: { title: "Verify quote", ...toolAnnotations },
} as const;

function indeterminateVerification(): IndeterminateVerificationResult {
	return {
		outcome: "indeterminate",
		contractVersion: CONTRACT_VERSION,
		reason: "verification_not_available",
	};
}

function indeterminateToolResponse() {
	return {
		content: [
			{
				type: "text" as const,
				text: "Verification is not yet available.",
			},
		],
		structuredContent: indeterminateVerification(),
		isError: true,
	};
}

export function registerIndeterminateVerificationTools(server: McpServer): void {
	server.registerTool("verify_citation", verifyCitationToolDefinition, () =>
		indeterminateToolResponse(),
	);
	server.registerTool("verify_quote", verifyQuoteToolDefinition, () => indeterminateToolResponse());
}
