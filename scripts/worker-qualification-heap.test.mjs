import assert from "node:assert/strict";
import test from "node:test";
import { captureHeapUsageSample, peakHeapUsageSample } from "./worker-qualification-heap.mjs";

test("uses totalSize rather than usedSize for the conservative isolate measurement", () => {
	// Given: Runtime.getHeapUsage reports a smaller live heap than its reserved heap total.
	const usage = {
		backingStorageSize: 7,
		embedderHeapUsedSize: 11,
		totalSize: 101,
		usedSize: 3,
	};

	// When: the runtime observation is recorded.
	const sample = captureHeapUsageSample(usage);

	// Then: all raw fields are retained and only totalSize contributes to the limit.
	assert.deepEqual(sample, { ...usage, conservativeIsolateBytes: 119 });
});

test("retains the raw fields from the sample with the highest conservative isolate sum", () => {
	// Given: two valid samples where the lower used heap has the higher conservative total.
	const samples = [
		captureHeapUsageSample({
			backingStorageSize: 10,
			embedderHeapUsedSize: 20,
			totalSize: 100,
			usedSize: 90,
		}),
		captureHeapUsageSample({
			backingStorageSize: 30,
			embedderHeapUsedSize: 40,
			totalSize: 200,
			usedSize: 1,
		}),
	];

	// When: the scenario peak is selected.
	const peak = peakHeapUsageSample(samples);

	// Then: the reported peak retains the exact raw fields that formed its 270-byte sum.
	assert.deepEqual(peak, samples[1]);
});

test("marks missing and nonfinite Runtime.getHeapUsage fields invalid", () => {
	// Given: CDP observations with a missing and a nonfinite raw field.
	const missing = captureHeapUsageSample({
		backingStorageSize: 1,
		embedderHeapUsedSize: 2,
		totalSize: 3,
	});
	const nonfinite = captureHeapUsageSample({
		backingStorageSize: Number.POSITIVE_INFINITY,
		embedderHeapUsedSize: 2,
		totalSize: 3,
		usedSize: 4,
	});

	// When: the samples are retained for qualification.
	const peak = peakHeapUsageSample([missing, nonfinite]);

	// Then: their conservative measurements cannot become a passing peak.
	assert.equal(missing.usedSize, null);
	assert.equal(missing.conservativeIsolateBytes, 6);
	assert.equal(nonfinite.conservativeIsolateBytes, null);
	assert.equal(peak, null);
});
