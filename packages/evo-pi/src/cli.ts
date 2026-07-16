#!/usr/bin/env node

import { main } from "@ch1nyzzz/pi-coding-agent";
import { createEvoExtension, runEvoCli } from "@ch1nyzzz/pi-evo";

process.title = "evo-pi";
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

const args = process.argv.slice(2);
const command = args[0]?.toLowerCase();

if (command === "search" || command === "install" || command === "import" || command === "export") {
	try {
		await runEvoCli(args);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
} else {
	await main(args, {
		extensionFactories: [createEvoExtension()],
	});
}
