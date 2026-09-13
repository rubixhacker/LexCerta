import { createHash } from "node:crypto";
import { z } from "zod";
import { abortable } from "../verification/evidence-request.js";
import {
	encodeRecoveryRecord,
	type RecoveryJournalReader,
	RecoveryRecord,
} from "./recovery-journal.js";

const Reference = z.strictObject({
	key: z.string().regex(/^restrictions\/v1\/(staging|production)\/[a-f0-9]{64}\.json$/),
	generation: z.string().regex(/^[1-9]\d{0,31}$/),
	createdAt: z.iso.datetime(),
});
const Page = z.strictObject({
	objects: z.array(Reference).max(100),
	nextPageToken: z.string().min(1).max(8192).nullable(),
});
const Bounds = z.strictObject({
	maxPages: z.number().int().min(1).max(100).default(100),
	maxRecords: z.number().int().min(1).max(10_000).default(10_000),
	timeoutMs: z.number().int().min(1).max(540_000).default(540_000),
});

export class RecoveryScanUnavailable extends Error {
	constructor() {
		super("recovery journal scan unavailable");
	}
}

export type RecoveryScan = {
	readonly environment: RecoveryRecord["environment"];
	readonly inventorySha256: string;
	readonly pages: number;
	readonly entries: readonly {
		readonly object: z.infer<typeof Reference>;
		readonly record: RecoveryRecord;
	}[];
};

// Collect a small pilot journal without holding SQL transactions over object I/O.
// A completed inventory is not a snapshot or a writer barrier. The recovery
// coordinator must establish isolation separately before using it for replay.
// Failure returns no partial inventory; retry starts from the first page.
export async function scanRecoveryJournal(
	reader: RecoveryJournalReader,
	environment: RecoveryRecord["environment"],
	options: {
		readonly signal?: AbortSignal;
		readonly bounds?: z.input<typeof Bounds>;
	} = {},
): Promise<RecoveryScan> {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		z.enum(["staging", "production"]).parse(environment);
		const bounds = Bounds.parse(options.bounds ?? {});
		const deadline = performance.now() + bounds.timeoutMs;
		timer = setTimeout(cancel, bounds.timeoutMs);
		if (options.signal?.aborted) cancel();
		else options.signal?.addEventListener("abort", cancel, { once: true });
		const checkpoint = () => {
			if (performance.now() >= deadline) cancel();
			if (controller.signal.aborted) throw new RecoveryScanUnavailable();
		};
		const wait = async <T>(operation: () => Promise<T>) => {
			checkpoint();
			const result = await abortable(operation, controller.signal);
			checkpoint();
			return result;
		};
		const keys = new Set<string>();
		const cursors = new Set<string>();
		const entries: RecoveryScan["entries"][number][] = [];
		let token: string | undefined;
		let pages = 0;
		do {
			if (pages >= bounds.maxPages) throw new RecoveryScanUnavailable();
			const page = Page.parse(await wait(() => reader.list(token, controller.signal)));
			pages += 1;
			if (entries.length + page.objects.length > bounds.maxRecords)
				throw new RecoveryScanUnavailable();
			if (page.nextPageToken !== null) {
				if (cursors.has(page.nextPageToken)) throw new RecoveryScanUnavailable();
				cursors.add(page.nextPageToken);
			}
			for (const object of page.objects) {
				if (!object.key.startsWith(`restrictions/v1/${environment}/`) || keys.has(object.key))
					throw new RecoveryScanUnavailable();
				keys.add(object.key);
				const record = RecoveryRecord.parse(
					await wait(() => reader.read(object, controller.signal)),
				);
				if (record.environment !== environment || encodeRecoveryRecord(record).key !== object.key)
					throw new RecoveryScanUnavailable();
				entries.push({ object, record });
			}
			token = page.nextPageToken ?? undefined;
		} while (token !== undefined);
		// Object names are ASCII. Sort without locale rules so page boundaries and
		// enumeration order do not change the digest of the verified generations.
		entries.sort((a, b) => (a.object.key < b.object.key ? -1 : 1));
		const inventory = createHash("sha256").update(
			`lexcerta-recovery-inventory-v1\n${environment}\n`,
		);
		for (const { object } of entries) inventory.update(`${JSON.stringify(object)}\n`);
		checkpoint();
		return { environment, inventorySha256: inventory.digest("hex"), pages, entries };
	} catch {
		throw new RecoveryScanUnavailable();
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", cancel);
		cancel();
	}
}
