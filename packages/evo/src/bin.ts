#!/usr/bin/env node

import { runEvoCli } from "./cli.ts";
import { runEvidenceResumptionWorker, runEvolutionWorker } from "./evolve/background.ts";
import { getEvoPaths } from "./paths.ts";

try {
	const args = process.argv.slice(2);
	if (args[0] === "__worker" || args[0] === "__worker-resume") {
		const [mode, root, runId, cwd] = args;
		if (!root || !runId || !cwd) throw new Error("Invalid evolution worker arguments");
		const worker = mode === "__worker-resume" ? runEvidenceResumptionWorker : runEvolutionWorker;
		await worker({ paths: getEvoPaths(root), runId, cwd });
	} else await runEvoCli(args);
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
