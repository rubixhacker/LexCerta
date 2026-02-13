/**
 * Reporter lookup table mapping normalized keys to canonical Bluebook forms.
 * Keys are lowercase, periods stripped, whitespace collapsed to single spaces.
 */
const REPORTER_MAP: Record<string, string> = {
	// === U.S. Supreme Court ===
	us: "U.S.",
	"u s": "U.S.",

	"s ct": "S. Ct.",
	sct: "S. Ct.",

	"l ed": "L. Ed.",
	led: "L. Ed.",
	"l ed 2d": "L. Ed. 2d",
	"led 2d": "L. Ed. 2d",
	led2d: "L. Ed. 2d",
	"l ed2d": "L. Ed. 2d",

	// === Federal Courts of Appeals ===
	f: "F.",
	"f 2d": "F.2d",
	f2d: "F.2d",
	"f 3d": "F.3d",
	f3d: "F.3d",
	"f 4th": "F.4th",
	f4th: "F.4th",

	// === Federal District Courts ===
	"f supp": "F. Supp.",
	fsupp: "F. Supp.",
	"f supp 2d": "F. Supp. 2d",
	"fsupp 2d": "F. Supp. 2d",
	fsupp2d: "F. Supp. 2d",
	"f supp 3d": "F. Supp. 3d",
	"fsupp 3d": "F. Supp. 3d",
	fsupp3d: "F. Supp. 3d",

	// === Regional Reporters ===
	// Atlantic
	a: "A.",
	"a 2d": "A.2d",
	a2d: "A.2d",
	"a 3d": "A.3d",
	a3d: "A.3d",

	// North Eastern
	"n e": "N.E.",
	ne: "N.E.",
	"n e 2d": "N.E.2d",
	"ne 2d": "N.E.2d",
	ne2d: "N.E.2d",
	"n e 3d": "N.E.3d",
	"ne 3d": "N.E.3d",
	ne3d: "N.E.3d",

	// North Western
	"n w": "N.W.",
	nw: "N.W.",
	"n w 2d": "N.W.2d",
	"nw 2d": "N.W.2d",
	nw2d: "N.W.2d",

	// Pacific
	p: "P.",
	"p 2d": "P.2d",
	p2d: "P.2d",
	"p 3d": "P.3d",
	p3d: "P.3d",

	// South Eastern
	"s e": "S.E.",
	se: "S.E.",
	"s e 2d": "S.E.2d",
	"se 2d": "S.E.2d",
	se2d: "S.E.2d",

	// South Western
	"s w": "S.W.",
	sw: "S.W.",
	"s w 2d": "S.W.2d",
	"sw 2d": "S.W.2d",
	sw2d: "S.W.2d",
	"s w 3d": "S.W.3d",
	"sw 3d": "S.W.3d",
	sw3d: "S.W.3d",

	// Southern
	so: "So.",
	"so 2d": "So. 2d",
	so2d: "So. 2d",
	"so 3d": "So. 3d",
	so3d: "So. 3d",
};

/**
 * Normalize a raw reporter string to its canonical Bluebook form.
 * Returns the canonical form or null if not recognized.
 */
export function normalizeReporter(raw: string): string | null {
	const key = raw
		.toLowerCase()
		.replace(/\./g, "")
		.replace(/\s+/g, " ")
		.trim();
	return REPORTER_MAP[key] ?? null;
}
