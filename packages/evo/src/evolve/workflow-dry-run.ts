import { validateEvoComponentSelection } from "../components/artifact.ts";
import { EvoComponentProcess } from "../components/process-runtime.ts";
import {
	createDefaultEvoAbiRegistry,
	WORKFLOW_V1_ABI,
	type WorkflowV1Input,
	type WorkflowV1Output,
} from "../components/registry.ts";
import type { EvoPaths } from "../paths.ts";
import type { EvoWorkflowSelection } from "../types.ts";

const STUB_STATE_DIGEST = "0".repeat(64);

/**
 * Canned capability responses for a dry run. The stub spawn-agent answers with
 * an empty JSON object so the orchestration exercises its full protocol
 * surface without spending a single model token; capabilities the stub cannot
 * fake fail with a clean capability error the component must survive.
 */
function stubCapabilityResult(capability: string, payload: unknown): unknown {
	if (capability === "spawn-agent") {
		const model = (payload as { model?: string }).model ?? "dry-run/stub";
		const slash = model.indexOf("/");
		return {
			schemaVersion: 1,
			status: "completed",
			model: { provider: model.slice(0, Math.max(slash, 0)) || "dry-run", id: model.slice(slash + 1) || "stub" },
			turns: 1,
			stopReason: "stop",
			messages: [{ role: "assistant", content: [{ type: "text", text: "{}" }] }],
		};
	}
	if (capability === "memory-read") return { stateDigest: STUB_STATE_DIGEST, fragments: [] };
	if (capability === "memory-write") return { stateDigest: STUB_STATE_DIGEST };
	throw Object.assign(new Error(`Capability is not available in a workflow dry run: ${capability}`), {
		code: "unavailable",
	});
}

export interface WorkflowDryRunOutcome {
	/** True when the component spoke the protocol cleanly end to end. */
	passed: boolean;
	/** Whether the invoke produced a result or a clean structured error. */
	invokeOutcome: "result" | "clean-error" | "protocol-failure";
	markdown: string;
}

/**
 * Launch a workflow/v1 selection against a stub capability broker and verify
 * protocol conformance: initialize, health, one invoke with empty args, and a
 * clean shutdown. A workflow whose orchestration fails on stub data may reply
 * with a structured error — that still passes; what fails the dry run is a
 * protocol violation (crash, truncated frame, outstanding capabilities,
 * unparseable reply).
 */
export async function dryRunWorkflowSelection(
	paths: EvoPaths,
	selection: EvoWorkflowSelection,
	options: { sandbox?: boolean; requestTimeoutMs?: number } = {},
): Promise<WorkflowDryRunOutcome> {
	const registry = createDefaultEvoAbiRegistry();
	const artifact = await validateEvoComponentSelection(paths, "workflow", selection, registry);
	const process = new EvoComponentProcess<WorkflowV1Input, WorkflowV1Output, Record<string, never>>(
		artifact,
		WORKFLOW_V1_ABI,
		{},
		{
			sandbox: options.sandbox,
			...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
			capabilityBroker: {
				request: async (_identity, frame) => stubCapabilityResult(frame.capability, frame.payload),
			},
		},
	);
	let invokeOutcome: WorkflowDryRunOutcome["invokeOutcome"];
	let detail = "";
	try {
		await process.start();
		await process.health();
		try {
			await process.invoke({
				trigger: selection.trigger,
				args: {},
				host: { model: "dry-run/stub", tools: [], maxOutputTokensPerCall: 1_024 },
			});
			invokeOutcome = "result";
		} catch (error) {
			detail = error instanceof Error ? error.message : String(error);
			// A clean structured error leaves the process healthy; a protocol
			// violation kills it and the follow-up health check throws.
			try {
				await process.health();
				invokeOutcome = "clean-error";
			} catch {
				invokeOutcome = "protocol-failure";
			}
		}
		if (invokeOutcome !== "protocol-failure") await process.shutdown();
		else await process.terminate(new Error("workflow dry run failed"));
	} catch (error) {
		detail = error instanceof Error ? error.message : String(error);
		invokeOutcome = "protocol-failure";
		await process.terminate(new Error("workflow dry run failed")).catch(() => undefined);
	}
	const passed = invokeOutcome !== "protocol-failure";
	const markdown = [
		"# Workflow dry run",
		"",
		`- workflow: ${selection.id} (${selection.trigger})`,
		`- artifact: ${selection.artifactDigest}`,
		`- execution boundary: ${process.sandboxKind ?? "unknown"}`,
		"- initialize: passed",
		`- invoke with stub capabilities: ${invokeOutcome}${detail ? ` (${detail.slice(0, 200)})` : ""}`,
		`- verdict: ${passed ? "passed" : "failed"}`,
		"",
	].join("\n");
	return { passed, invokeOutcome, markdown };
}
