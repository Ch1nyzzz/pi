import { composeWorkflowEntrypoint } from "../../components/workflow-sdk/index.ts";
import { type WrittenWorkflowPack, writeWorkflowPack } from "./write-pack.ts";

export const DEEPCODE_WORKFLOW_ID = "deepcode";
export const DEEPCODE_TRIGGER = "/deepcode";

/**
 * The /deepcode workflow body: dynamic-workflow style multi-agent coding.
 * Parallel read-only explorers map the codebase, a planner freezes a step
 * plan, one coder implements each step in order (steps share the working
 * tree, so implementation is deliberately serial), and a verify-fix loop runs
 * the project check until it passes or stops making progress.
 */
export const DEEPCODE_WORKFLOW_BODY = String.raw`
const NOTES_SCHEMA = {
	type: "object",
	required: ["notes"],
	properties: { notes: { type: "string" } },
};
const PLAN_SCHEMA = {
	type: "object",
	required: ["steps", "checkCommand"],
	properties: {
		steps: {
			type: "array",
			items: {
				type: "object",
				required: ["title", "instructions"],
				properties: {
					title: { type: "string" },
					instructions: { type: "string" },
					files: { type: "array", items: { type: "string" } },
				},
			},
		},
		checkCommand: { type: "string" },
	},
};
const STEP_SCHEMA = {
	type: "object",
	required: ["done", "summary"],
	properties: { done: { type: "boolean" }, summary: { type: "string" } },
};
const CHECK_SCHEMA = {
	type: "object",
	required: ["passed", "detail"],
	properties: { passed: { type: "boolean" }, detail: { type: "string" } },
};

const MAX_STEPS = 8;
const MAX_FIX_ROUNDS = 3;

runWorkflow(async ({ args }) => {
	const task = typeof args.text === "string" && args.text.trim() ? args.text.trim() : "";
	if (!task) throw new Error("Usage: /deepcode <task description>");

	// Phase 1: parallel read-only understanding (three complementary lenses).
	const lenses = [
		"Map the architecture relevant to this task: entry points, key modules, data flow. Read files; do not modify anything.",
		"Find every file this task will need to touch or understand, with one line each on why. Read files; do not modify anything.",
		"Describe the project's conventions this task must follow: test layout, lint/build commands, code style, error handling. Read files; do not modify anything.",
	];
	const understanding = await parallel(
		lenses.map((lens) => () => agent("Task: " + task + "\n\n" + lens, { schema: NOTES_SCHEMA })),
	);
	const notes = understanding
		.filter(Boolean)
		.map((entry, index) => "## Lens " + (index + 1) + "\n" + entry.notes)
		.join("\n\n");
	log("deepcode: understanding collected from " + understanding.filter(Boolean).length + " explorer(s)");

	// Phase 2: freeze a step plan. The planner reads but never writes.
	const plan = await agent(
		"Task: " +
			task +
			"\n\nCodebase notes from parallel explorers:\n" +
			notes +
			"\n\nWrite an implementation plan of at most " +
			MAX_STEPS +
			" ordered steps. Each step must be independently completable by one coding agent and name the files it touches. Also give the single shell command that verifies the whole task (the project's own check or test command). Read files to confirm your plan; do not modify anything.",
		{ schema: PLAN_SCHEMA },
	);
	const steps = plan.steps.slice(0, MAX_STEPS);
	log("deepcode: " + steps.length + " step(s), check: " + plan.checkCommand);

	// Phase 3: implement steps in order. Steps share one working tree, so
	// implementation is serial by design; breadth lives in phases 1 and 4.
	const stepResults = [];
	for (const [index, step] of steps.entries()) {
		const result = await agent(
			"You are implementing step " +
				(index + 1) +
				"/" +
				steps.length +
				" of this task: " +
				task +
				"\n\nStep: " +
				step.title +
				"\nInstructions: " +
				step.instructions +
				(step.files?.length ? "\nExpected files: " + step.files.join(", ") : "") +
				"\n\nEarlier steps already done: " +
				JSON.stringify(stepResults.map((entry) => entry.title)) +
				"\n\nImplement the step completely (edit/write/run as needed). Do not start later steps.",
			{ schema: STEP_SCHEMA },
		);
		stepResults.push({ title: step.title, done: result.done, summary: result.summary });
		log("deepcode: step " + (index + 1) + " " + (result.done ? "done" : "incomplete") + ": " + step.title);
	}

	// Phase 4: verify-fix loop until the check passes or progress stalls.
	let verification = { passed: false, detail: "not run" };
	let lastDetail = "";
	for (let round = 0; round < MAX_FIX_ROUNDS; round += 1) {
		verification = await agent(
			"Run this check command with bash and report the outcome truthfully: " +
				plan.checkCommand +
				"\nIf it fails, include the essential failure output in detail. Do not fix anything in this run.",
			{ schema: CHECK_SCHEMA },
		);
		if (verification.passed) break;
		if (verification.detail === lastDetail) {
			log("deepcode: no progress between fix rounds, stopping");
			break;
		}
		lastDetail = verification.detail;
		log("deepcode: check failed, fix round " + (round + 1));
		await agent(
			"The check '" +
				plan.checkCommand +
				"' failed while finishing this task: " +
				task +
				"\n\nFailure output:\n" +
				verification.detail +
				"\n\nDiagnose and fix the failures, then re-run the check yourself to confirm.",
			{ schema: STEP_SCHEMA },
		);
	}

	return { task, steps: stepResults, checkCommand: plan.checkCommand, verification };
});
`;

/** The composed single-file component entrypoint (SDK prelude + body). */
export function composeDeepcodeEntrypoint(): Promise<string> {
	return composeWorkflowEntrypoint(DEEPCODE_WORKFLOW_BODY);
}

/** Write a complete, importable /deepcode optimization pack into `directory`. */
export function writeDeepcodePack(directory: string): Promise<WrittenWorkflowPack> {
	return writeWorkflowPack(directory, {
		id: DEEPCODE_WORKFLOW_ID,
		trigger: DEEPCODE_TRIGGER,
		version: "1.0.0",
		description:
			"Dynamic-workflow style multi-agent coding: parallel explorers, a frozen step plan, serial implementation, and a verify-fix loop.",
		body: DEEPCODE_WORKFLOW_BODY,
	});
}
