#!/usr/bin/env node

import { runEvoCli } from "./cli.ts";
import { runEvolutionWorker } from "./evolve/background.ts";
import { getEvoPaths } from "./paths.ts";

try {
	const args = process.argv.slice(2);
	if (args[0] === "__worker") {
		const [, root, runId, cwd] = args;
		if (!root || !runId || !cwd) throw new Error("Invalid evolution worker arguments");
		await runEvolutionWorker({ paths: getEvoPaths(root), runId, cwd });
	} else await runEvoCli(args);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
