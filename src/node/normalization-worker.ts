import { parentPort } from "node:worker_threads";
import { z } from "zod";
import { EvidenceRequestFailure, MAX_SOURCE_BYTES } from "../verification/evidence-request.js";
import { canonicalOpinionText } from "../verification/quote-normalization.js";

const input = z
	.object({
		id: z.number().int().positive(),
		selected: z
			.object({
				representation: z.enum(["html_with_citations", "html", "plain_text"]),
				content: z.string().max(MAX_SOURCE_BYTES),
			})
			.strict(),
	})
	.strict();

if (parentPort === null) throw new Error("Normalization requires a worker thread");
const port = parentPort;
port.on("message", async (message: unknown) => {
	const parsed = input.safeParse(message);
	if (!parsed.success) {
		port.close();
		return;
	}
	const { id, selected } = parsed.data;
	try {
		const text = await canonicalOpinionText(selected);
		port.postMessage({ id, kind: "normalized", text });
	} catch (error) {
		port.postMessage({
			id,
			kind: "failed",
			reason: error instanceof EvidenceRequestFailure ? error.reason : "incomplete",
		});
	}
});
