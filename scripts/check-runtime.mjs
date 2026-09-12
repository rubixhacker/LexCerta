import { readFileSync } from "node:fs";

const expected = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
if (process.version !== `v${expected}`) {
	throw new Error(`Use Node ${expected}; running ${process.version} at ${process.execPath}`);
}
console.log(`Node ${process.version} at ${process.execPath}`);
