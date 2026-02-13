import { describe, expect, it } from "vitest";
import { type ToolResponseEnvelope, createToolResponse } from "../types.js";

describe("Response envelope format (Success Criterion 4)", () => {
	it("createToolResponse returns content array with one text item", () => {
		const result = createToolResponse({
			valid: true,
			metadata: { foo: "bar" },
			error: null,
		});
		expect(result.content).toHaveLength(1);
		expect(result.content[0].type).toBe("text");
		expect(typeof result.content[0].text).toBe("string");
	});

	it("text content parses to the original envelope", () => {
		const envelope: ToolResponseEnvelope = {
			valid: true,
			metadata: { foo: "bar" },
			error: null,
		};
		const result = createToolResponse(envelope);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed).toEqual(envelope);
	});

	it("error envelope serializes correctly", () => {
		const envelope: ToolResponseEnvelope = {
			valid: false,
			metadata: null,
			error: { code: "TEST", message: "fail" },
		};
		const result = createToolResponse(envelope);
		const parsed = JSON.parse(result.content[0].text);
		expect(parsed.valid).toBe(false);
		expect(parsed.metadata).toBeNull();
		expect(parsed.error).toEqual({ code: "TEST", message: "fail" });
	});

	it("envelope always has exactly three top-level keys: valid, metadata, error", () => {
		const envelope: ToolResponseEnvelope = {
			valid: true,
			metadata: { x: 1 },
			error: null,
		};
		const result = createToolResponse(envelope);
		const parsed = JSON.parse(result.content[0].text);
		const keys = Object.keys(parsed).sort();
		expect(keys).toEqual(["error", "metadata", "valid"]);
	});
});
