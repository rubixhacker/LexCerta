import { parseFragment } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type {
	OpinionTextRepresentation,
	OpinionTextSource,
	SelectedOpinionText,
} from "./quote-contract.js";

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

export async function canonicalOpinionText(selected: SelectedOpinionText): Promise<string> {
	switch (selected.representation) {
		case "plain_text":
			return normalizeQuoteText(selected.content);
		case "html_with_citations":
		case "html":
			return normalizeQuoteText(await htmlText(selected.content));
	}
}

async function htmlText(html: string): Promise<string> {
	const fragments: string[] = [];
	appendChildren(parseFragment(html), fragments);
	return fragments.join("");
}

function appendChildren(node: DefaultTreeAdapterTypes.ParentNode, fragments: string[]): void {
	for (const child of node.childNodes) appendNode(child, fragments);
}

function appendNode(node: DefaultTreeAdapterTypes.ChildNode, fragments: string[]): void {
	if ("value" in node) {
		fragments.push(node.value);
		return;
	}
	if (!("tagName" in node)) return;
	const tagName = node.tagName.toLowerCase();
	if (tagName === "script" || tagName === "style") return;
	const boundary = BLOCK_TAGS.has(tagName);
	if (boundary) fragments.push(" ");
	appendChildren(node, fragments);
	if (boundary) fragments.push(" ");
}
