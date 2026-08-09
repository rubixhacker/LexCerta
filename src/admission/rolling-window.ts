import type { ApiKeyLimits } from "../admin/key-lifecycle.js";

const MINUTE_MILLISECONDS = 60_000;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;

export type Clock = {
	readonly now: () => Date;
};

export type RollingWindowAdmissionInput = {
	readonly admissions: readonly Date[];
	readonly clock: Clock;
	readonly limits: ApiKeyLimits;
};

export type RollingWindowAdmissionResult =
	| { readonly kind: "allowed"; readonly admissions: readonly Date[] }
	| {
			readonly kind: "exhausted";
			readonly admissions: readonly Date[];
			readonly retryAfterSeconds: number;
	  };

export function admitRollingWindow(
	input: RollingWindowAdmissionInput,
): RollingWindowAdmissionResult {
	const now = input.clock.now();
	const dayAdmissions = admissionsInWindow(input.admissions, now, DAY_MILLISECONDS);
	const minuteAdmissions = admissionsInWindow(dayAdmissions, now, MINUTE_MILLISECONDS);
	const minuteExhausted = minuteAdmissions.length >= input.limits.minute;
	const dayExhausted = dayAdmissions.length >= input.limits.day;

	if (!minuteExhausted && !dayExhausted) {
		return { kind: "allowed", admissions: [...dayAdmissions, now] };
	}

	return {
		kind: "exhausted",
		admissions: dayAdmissions,
		retryAfterSeconds: retryAfterSeconds({
			dayAdmissions,
			dayExhausted,
			limits: input.limits,
			minuteAdmissions,
			minuteExhausted,
			now,
		}),
	};
}

function admissionsInWindow(
	admissions: readonly Date[],
	now: Date,
	windowMilliseconds: number,
): readonly Date[] {
	const windowStart = now.getTime() - windowMilliseconds;
	return admissions.filter((admission) => admission.getTime() > windowStart);
}

function retryAfterSeconds(input: {
	readonly dayAdmissions: readonly Date[];
	readonly dayExhausted: boolean;
	readonly limits: ApiKeyLimits;
	readonly minuteAdmissions: readonly Date[];
	readonly minuteExhausted: boolean;
	readonly now: Date;
}): number {
	const openingTimes = [
		...(input.minuteExhausted
			? [nextOpeningTime(input.minuteAdmissions, input.limits.minute, MINUTE_MILLISECONDS)]
			: []),
		...(input.dayExhausted
			? [nextOpeningTime(input.dayAdmissions, input.limits.day, DAY_MILLISECONDS)]
			: []),
	];
	const latestOpeningTime = Math.max(...openingTimes);
	return Math.max(1, Math.ceil((latestOpeningTime - input.now.getTime()) / 1_000));
}

function nextOpeningTime(
	admissions: readonly Date[],
	limit: number,
	windowMilliseconds: number,
): number {
	const sortedAdmissions = [...admissions].sort((left, right) => left.getTime() - right.getTime());
	const blockingAdmission = sortedAdmissions[admissions.length - limit];
	if (blockingAdmission === undefined)
		throw new RangeError("exhausted window lacks a blocking admission");
	return blockingAdmission.getTime() + windowMilliseconds;
}
