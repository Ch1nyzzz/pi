import { readFile } from "node:fs/promises";

const SDK_URL = new URL("./sdk.mjs", import.meta.url);

/** The single-file workflow SDK prelude (plain ESM JavaScript). */
export async function readWorkflowSdkSource(): Promise<string> {
	return readFile(SDK_URL, "utf8");
}

/**
 * Compose a self-contained workflow component entrypoint: the SDK prelude
 * followed by the author's script body. Artifacts accept exactly one
 * entrypoint file, so the SDK is concatenated rather than imported; the
 * artifact digest therefore covers the exact SDK revision the pack ships.
 *
 * The body runs in the same module scope as the prelude and is expected to
 * end with a `runWorkflow(async ({ trigger, args, host }) => { ... })` call;
 * `agent()`, `parallel()`, `pipeline()`, and `log()` are in scope.
 */
export async function composeWorkflowEntrypoint(body: string): Promise<string> {
	if (!body.includes("runWorkflow(")) {
		throw new Error("Workflow body must call runWorkflow(handler)");
	}
	const sdk = await readWorkflowSdkSource();
	return [sdk, "", "// ---- workflow body (author code) ----", body.trim(), ""].join("\n");
}
