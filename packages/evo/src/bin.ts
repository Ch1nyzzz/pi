#!/usr/bin/env node

import { runEvoCli } from "./cli.ts";

try {
	await runEvoCli(process.argv.slice(2));
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
