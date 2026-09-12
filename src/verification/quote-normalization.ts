import {
	parseFragment,
	defaultTreeAdapter,
	type TreeAdapter,
	type DefaultTreeAdapterMap,
} from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import { EvidenceRequestFailure, MAX_SOURCE_BYTES, evidenceFailure } from "./evidence-request.js";
import type { OpinionTextSource, SelectedOpinionText } from "./quote-contract.js";

const SAFE_WHITESPACE = /[\t\n\v\f\r \u00a0]+/g;
const TYPOGRAPHIC_QUOTES = /[\u2018\u2019\u201A\u201B]/g;
const TYPOGRAPHIC_DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F]/g;
const EQUIVALENT_DASHES = /[\u2010-\u2015\u2212]/g;
const BLOCK_TAGS = new Set<string>([
	"address",
	"article",
	"aside",
	"blockquote",
	"br",
	"div",
	"footer",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"header",
	"hr",
	"li",
	"main",
	"ol",
	"p",
	"pre",
	"section",
	"table",
	"td",
	"th",
	"tr",
	"ul",
] as const);

export function normalizeQuoteText(value: string): string {
	return value
		.normalize("NFC")
		.replace(TYPOGRAPHIC_QUOTES, "'")
		.replace(TYPOGRAPHIC_DOUBLE_QUOTES, '"')
		.replace(EQUIVALENT_DASHES, "-")
		.replace(SAFE_WHITESPACE, " ")
		.trim();
}

export function selectOpinionText(source: OpinionTextSource): SelectedOpinionText | undefined {
	for (const representation of ["html_with_citations", "html", "plain_text"] as const) {
		const content = source[representation];
		if (content !== undefined && content.trim().length > 0) return { representation, content };
	}
	return undefined;
}

export const NORMALIZATION_TIMEOUT_MS = 5_000;
const MAX_TREE_NODES = 50_000;
export type OpinionNormalizer = (
	selected: SelectedOpinionText,
	signal: AbortSignal,
) => Promise<string>;

export async function canonicalOpinionText(
	selected: SelectedOpinionText,
	signal?: AbortSignal,
): Promise<string> {
	const deadline = performance.now() + NORMALIZATION_TIMEOUT_MS;
	const checkpoint = () => {
		if (signal?.aborted) throw evidenceFailure(signal);
		if (performance.now() >= deadline) throw new EvidenceRequestFailure("timeout");
	};
	checkpoint();
	if (
		selected.content.length > MAX_SOURCE_BYTES ||
		!selected.content.isWellFormed() ||
		new TextEncoder().encode(selected.content).byteLength > MAX_SOURCE_BYTES
	)
		throw new EvidenceRequestFailure("incomplete");
	let text: string;
	switch (selected.representation) {
		case "plain_text":
			text = selected.content;
			break;
		case "html_with_citations":
		case "html":
			text = htmlText(selected.content, checkpoint);
			break;
	}
	checkpoint();
	const normalized = normalizeQuoteText(text);
	checkpoint();
	return normalized;
}

function htmlText(html: string, checkpoint: () => void): string {
	const fragments: string[] = [];
	const tree = parseFragment(html, { treeAdapter: boundedTreeAdapter(checkpoint) });
	// Keep parse5's HTML5 tree correction and original traversal order, without
	// recursive JS calls on adversarially deep markup.
	const stack: (DefaultTreeAdapterTypes.ChildNode | "boundary")[] = [...tree.childNodes].reverse();
	let visited = 0;
	while (stack.length) {
		if (++visited % 256 === 0) checkpoint();
		const node = stack.pop();
		if (node === undefined) break;
		if (node === "boundary") {
			fragments.push(" ");
			continue;
		}
		if ("value" in node) {
			fragments.push(node.value);
			continue;
		}
		if (!("tagName" in node)) continue;
		const tag = node.tagName.toLowerCase();
		if (tag === "script" || tag === "style") continue;
		const boundary = BLOCK_TAGS.has(tag);
		if (boundary) {
			fragments.push(" ");
			stack.push("boundary");
		}
		for (let index = node.childNodes.length - 1; index >= 0; index--) {
			const child = node.childNodes[index];
			if (child !== undefined) stack.push(child);
		}
	}
	return fragments.join("");
}

function boundedTreeAdapter(checkpoint: () => void): TreeAdapter<DefaultTreeAdapterMap> {
	let nodes = 0;
	let operations = 0;
	const charge = (allocated: number) => {
		nodes += allocated;
		if (nodes > MAX_TREE_NODES) throw new EvidenceRequestFailure("incomplete");
		if (++operations % 256 === 0) checkpoint();
	};
	return {
		...defaultTreeAdapter,
		createElement: (...args) => {
			charge(1);
			return defaultTreeAdapter.createElement(...args);
		},
		createCommentNode: (...args) => {
			charge(1);
			return defaultTreeAdapter.createCommentNode(...args);
		},
		createTextNode: (...args) => {
			charge(1);
			return defaultTreeAdapter.createTextNode(...args);
		},
		insertText: (...args) => {
			const children = defaultTreeAdapter.getChildNodes(args[0]);
			const before = children.length;
			defaultTreeAdapter.insertText(...args);
			// parse5 may append many tokens to one existing text node. Count the
			// actual allocation while still checking time on token operations.
			charge(children.length - before);
		},
		insertTextBefore: (...args) => {
			const children = defaultTreeAdapter.getChildNodes(args[0]);
			const before = children.length;
			defaultTreeAdapter.insertTextBefore(...args);
			charge(children.length - before);
		},
	};
}
