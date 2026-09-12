import { Worker } from "node:worker_threads";
import { z } from "zod";
import {
	EvidenceRequestFailure,
	MAX_SOURCE_BYTES,
	evidenceFailure,
} from "../verification/evidence-request.js";
import type { SelectedOpinionText } from "../verification/quote-contract.js";
import {
	NORMALIZATION_TIMEOUT_MS,
	type OpinionNormalizer,
} from "../verification/quote-normalization.js";

const reply = z.discriminatedUnion("kind", [
	z
		.object({
			id: z.number().int().positive(),
			kind: z.literal("normalized"),
			text: z.string().max(2 * MAX_SOURCE_BYTES),
		})
		.strict(),
	z
		.object({
			id: z.number().int().positive(),
			kind: z.literal("failed"),
			reason: z.enum(["incomplete", "timeout"]),
		})
		.strict(),
]);

type Job = {
	readonly id: number;
	readonly selected: SelectedOpinionText;
	readonly signal: AbortSignal;
	readonly resolve: (text: string) => void;
	readonly reject: (error: EvidenceRequestFailure) => void;
	readonly abort: () => void;
	readonly timer: ReturnType<typeof setTimeout>;
};
type Slot = {
	readonly worker: Worker;
	job: Job | undefined;
	stopping: boolean;
	readonly exited: Promise<void>;
};

// Two parsing workers, with six queued requests, fit the eight-request service
// concurrency. The queue holds bounded source strings, never submitted quotes.
export class NodeOpinionNormalizer {
	readonly #slots = new Set<Slot>();
	readonly #queue: Job[] = [];
	readonly #workerUrl: URL;
	readonly #timeoutMs: number;
	#nextId = 0;
	#closed = false;

	constructor(options: { readonly workerUrl?: URL; readonly timeoutMs?: number } = {}) {
		this.#workerUrl = options.workerUrl ?? new URL("./normalization-worker.js", import.meta.url);
		this.#timeoutMs = options.timeoutMs ?? NORMALIZATION_TIMEOUT_MS;
		if (
			this.#workerUrl.protocol !== "file:" ||
			!Number.isInteger(this.#timeoutMs) ||
			this.#timeoutMs < 1 ||
			this.#timeoutMs > NORMALIZATION_TIMEOUT_MS
		)
			throw new RangeError("Invalid normalization configuration");
	}

	readonly normalize: OpinionNormalizer = (selected, signal) => {
		if (signal.aborted) return Promise.reject(evidenceFailure(signal));
		if (
			this.#closed ||
			selected.content.length > MAX_SOURCE_BYTES ||
			!selected.content.isWellFormed() ||
			Buffer.byteLength(selected.content) > MAX_SOURCE_BYTES ||
			(this.#queue.length >= 6 && this.#slots.size >= 2)
		)
			return Promise.reject(new EvidenceRequestFailure("incomplete"));
		return new Promise((resolve, reject) => {
			const id = ++this.#nextId;
			const abort = () => this.#cancel(id, evidenceFailure(signal));
			const timer = setTimeout(
				() => this.#cancel(id, new EvidenceRequestFailure("timeout")),
				this.#timeoutMs,
			);
			const job: Job = { id, selected, signal, resolve, reject, abort, timer };
			signal.addEventListener("abort", abort, { once: true });
			this.#queue.push(job);
			this.#drain();
		});
	};

	get state() {
		return {
			workers: this.#slots.size,
			queued: this.#queue.length,
			active: [...this.#slots].filter((slot) => slot.job !== undefined).length,
		};
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const job of this.#queue.splice(0))
			this.#finish(job, new EvidenceRequestFailure("incomplete"));
		const slots = [...this.#slots];
		for (const slot of slots) this.#stop(slot, new EvidenceRequestFailure("incomplete"));
		await Promise.all(slots.map((slot) => slot.exited));
	}

	#drain(): void {
		if (this.#closed) return;
		while (this.#queue.length) {
			let slot = [...this.#slots].find(
				(candidate) => !candidate.stopping && candidate.job === undefined,
			);
			if (slot === undefined) {
				if (this.#slots.size >= 2) return;
				try {
					slot = this.#spawn();
				} catch {
					const job = this.#queue.shift();
					if (job !== undefined) this.#finish(job, new EvidenceRequestFailure("incomplete"));
					continue;
				}
			}
			const job = this.#queue.shift();
			if (job === undefined) return;
			if (job.signal.aborted) {
				this.#finish(job, evidenceFailure(job.signal));
				continue;
			}
			slot.job = job;
			try {
				slot.worker.postMessage({ id: job.id, selected: job.selected });
			} catch {
				this.#stop(slot, new EvidenceRequestFailure("incomplete"));
			}
		}
	}

	#spawn(): Slot {
		const worker = new Worker(this.#workerUrl, {
			resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
			// No application secrets or parent preload flags are needed to parse.
			env: {},
			execArgv: [],
			stdout: true,
			stderr: true,
		});
		worker.stdout.resume();
		worker.stderr.resume();
		let exited: () => void = () => undefined;
		const slot: Slot = {
			worker,
			job: undefined,
			stopping: false,
			exited: new Promise((resolve) => {
				exited = resolve;
			}),
		};
		this.#slots.add(slot);
		worker.on("message", (message: unknown) => {
			if (slot.stopping) return;
			const parsed = reply.safeParse(message);
			const job = slot.job;
			if (!parsed.success || job === undefined || parsed.data.id !== job.id) {
				this.#stop(slot, new EvidenceRequestFailure("incomplete"));
				return;
			}
			slot.job = undefined;
			const result = parsed.data;
			this.#finish(
				job,
				job.signal.aborted
					? evidenceFailure(job.signal)
					: result.kind === "failed"
						? new EvidenceRequestFailure(result.reason)
						: result.text,
			);
			this.#drain();
		});
		worker.on("error", () => this.#stop(slot, new EvidenceRequestFailure("incomplete")));
		worker.on("exit", () => {
			if (slot.job !== undefined) this.#finish(slot.job, new EvidenceRequestFailure("incomplete"));
			slot.job = undefined;
			this.#slots.delete(slot);
			exited();
			this.#drain();
		});
		return slot;
	}

	#cancel(id: number, error: EvidenceRequestFailure): void {
		const index = this.#queue.findIndex((job) => job.id === id);
		if (index >= 0) {
			const [job] = this.#queue.splice(index, 1);
			if (job !== undefined) this.#finish(job, error);
			return;
		}
		const slot = [...this.#slots].find((slot) => slot.job?.id === id);
		if (slot !== undefined) this.#stop(slot, error);
	}

	#stop(slot: Slot, failure: EvidenceRequestFailure): void {
		if (slot.stopping) return;
		slot.stopping = true;
		const job = slot.job;
		slot.job = undefined;
		if (job !== undefined) {
			this.#cleanup(job);
			// Settle cancellation only after the CPU worker has actually exited.
			void slot.exited.then(() => job.reject(failure));
		}
		void slot.worker.terminate().catch(() => undefined);
	}

	#finish(job: Job, result: string | EvidenceRequestFailure): void {
		this.#cleanup(job);
		if (typeof result === "string") job.resolve(result);
		else job.reject(result);
	}

	#cleanup(job: Job): void {
		clearTimeout(job.timer);
		job.signal.removeEventListener("abort", job.abort);
	}
}
