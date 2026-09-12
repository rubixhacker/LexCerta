export const MAX_SOURCE_BYTES = 1_048_576;
export const MAX_EVIDENCE_BYTES = 16 * MAX_SOURCE_BYTES;
export const EVIDENCE_DEADLINE_MS = 55_000;

export class EvidenceRequestFailure extends Error {
	constructor(readonly reason: "incomplete" | "timeout") {
		super(reason === "timeout" ? "Evidence deadline or cancellation" : "Evidence resource limit");
		this.name = "EvidenceRequestFailure";
	}
}

export function evidenceFailure(signal: AbortSignal): EvidenceRequestFailure {
	return signal.reason instanceof EvidenceRequestFailure
		? signal.reason
		: new EvidenceRequestFailure("timeout");
}

// Waiting is bounded even when an injected adapter ignores cancellation. The
// adapter still receives the same signal and must stop its own I/O or CPU work.
export function abortable<Value>(
	operation: () => Promise<Value>,
	signal: AbortSignal,
): Promise<Value> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(evidenceFailure(signal));
		if (signal.aborted) return abort();
		signal.addEventListener("abort", abort, { once: true });
		Promise.resolve()
			.then(() => {
				if (signal.aborted) throw evidenceFailure(signal);
				return operation();
			})
			.then(resolve, reject)
			.finally(() => signal.removeEventListener("abort", abort));
	});
}

export class EvidenceRequest {
	readonly #controller = new AbortController();
	readonly #deadline: number;
	readonly #timer: ReturnType<typeof setTimeout>;
	readonly #parent: AbortSignal | undefined;
	readonly #cancel = () => this.#controller.abort(new EvidenceRequestFailure("timeout"));
	readonly #maxBytes: number;
	#responseBytes = 0;
	#sourceBytes = 0;

	constructor(
		options: {
			readonly signal?: AbortSignal;
			readonly timeoutMs?: number;
			readonly maxBytes?: number;
		} = {},
	) {
		const timeout = options.timeoutMs ?? EVIDENCE_DEADLINE_MS;
		this.#maxBytes = options.maxBytes ?? MAX_EVIDENCE_BYTES;
		if (
			!Number.isSafeInteger(timeout) ||
			timeout < 1 ||
			timeout > EVIDENCE_DEADLINE_MS ||
			!Number.isSafeInteger(this.#maxBytes) ||
			this.#maxBytes < 1 ||
			this.#maxBytes > MAX_EVIDENCE_BYTES
		) {
			throw new RangeError("Invalid evidence request bounds");
		}
		this.#deadline = performance.now() + timeout;
		this.#timer = setTimeout(this.#cancel, timeout);
		this.#parent = options.signal;
		if (this.#parent?.aborted) this.#cancel();
		else this.#parent?.addEventListener("abort", this.#cancel, { once: true });
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}
	get responseBytes(): number {
		return this.#responseBytes;
	}
	get sourceBytes(): number {
		return this.#sourceBytes;
	}

	checkpoint(): void {
		if (performance.now() >= this.#deadline) this.#cancel();
		if (this.signal.aborted) throw evidenceFailure(this.signal);
	}

	consumeResponseBytes(bytes: number): void {
		this.checkpoint();
		this.#responseBytes += bytes;
		if (!Number.isSafeInteger(bytes) || bytes < 0 || this.#responseBytes > this.#maxBytes)
			this.#limit();
	}

	consumeSource(content: string): void {
		this.checkpoint();
		// Reject by code-unit length before allocating the UTF-8 encoding.
		if (content.length > MAX_SOURCE_BYTES) this.#limit();
		const bytes = new TextEncoder().encode(content).byteLength;
		this.#sourceBytes += bytes;
		if (bytes > MAX_SOURCE_BYTES || this.#sourceBytes > this.#maxBytes) this.#limit();
	}

	run<Value>(operation: () => Promise<Value>): Promise<Value> {
		this.checkpoint();
		return abortable(operation, this.signal).then((value) => {
			// A synchronous adapter can delay the timer callback. Recheck the
			// monotonic deadline before accepting its result.
			this.checkpoint();
			return value;
		});
	}

	wait(milliseconds: number): Promise<void> {
		this.checkpoint();
		return new Promise((resolve, reject) => {
			const abort = () => {
				clearTimeout(timer);
				reject(evidenceFailure(this.signal));
			};
			const timer = setTimeout(() => {
				this.signal.removeEventListener("abort", abort);
				resolve();
			}, milliseconds);
			this.signal.addEventListener("abort", abort, { once: true });
		});
	}

	close(): void {
		clearTimeout(this.#timer);
		this.#parent?.removeEventListener("abort", this.#cancel);
		this.#cancel();
	}

	#limit(): never {
		const failure = new EvidenceRequestFailure("incomplete");
		this.#controller.abort(failure);
		throw failure;
	}
}
