import { connectPilot, runPilot } from "../examples/pilot-client.ts";

const endpoint = process.env.LEXCERTA_URL;
const key = process.env.LEXCERTA_API_KEY;
const citation = process.env.LEXCERTA_CITATION;
const quote = process.env.LEXCERTA_QUOTE;
if (!endpoint || !key || !citation || !quote) {
	console.error("Set LEXCERTA_URL, LEXCERTA_API_KEY, LEXCERTA_CITATION and LEXCERTA_QUOTE.");
	process.exitCode = 1;
} else {
	let client;
	try {
		client = await connectPilot(new URL(endpoint), key);
		console.log(JSON.stringify(await runPilot(client, citation, quote), null, 2));
	} catch {
		// Do not print transport errors: they can contain request data or credentials.
		console.error(
			"LexCerta request failed. Check the endpoint, key expiry and allowance; do not interpret this as a negative evidence finding.",
		);
		process.exitCode = 1;
	} finally {
		await client?.close();
	}
}
