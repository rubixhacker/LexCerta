const rawHeapUsageFields = ["backingStorageSize", "embedderHeapUsedSize", "totalSize", "usedSize"];

export function captureHeapUsageSample(heapUsage) {
	const sample = Object.fromEntries(
		rawHeapUsageFields.map((field) => [field, finiteOrNull(heapUsage?.[field])]),
	);
	const { backingStorageSize, embedderHeapUsedSize, totalSize } = sample;
	const conservativeIsolateBytes =
		backingStorageSize === null || embedderHeapUsedSize === null || totalSize === null
			? null
			: finiteOrNull(totalSize + embedderHeapUsedSize + backingStorageSize);
	return { ...sample, conservativeIsolateBytes };
}

export function peakHeapUsageSample(samples) {
	if (!Array.isArray(samples) || samples.length === 0 || !samples.every(isValidHeapUsageSample))
		return null;
	return samples.reduce((peak, sample) =>
		sample.conservativeIsolateBytes > peak.conservativeIsolateBytes ? sample : peak,
	);
}

function isValidHeapUsageSample(sample) {
	return (
		sample !== null &&
		typeof sample === "object" &&
		rawHeapUsageFields.every((field) => Number.isFinite(sample[field])) &&
		Number.isFinite(sample.conservativeIsolateBytes)
	);
}

function finiteOrNull(value) {
	return Number.isFinite(value) ? value : null;
}
