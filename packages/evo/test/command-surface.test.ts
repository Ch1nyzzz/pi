import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { type EvoCliIO, runEvoCli } from "../src/cli.ts";
import { EvoCapabilityBroker } from "../src/components/capabilities/broker.ts";
import { readEvoControlConfig } from "../src/evolve/config.ts";
import { loadEvoPack } from "../src/pack/pack.ts";
import { getEvoPaths } from "../src/paths.ts";
import { proposalApproval } from "../src/proposal.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import { writeScheduleConfig } from "../src/scheduler.ts";
import { EvoService } from "../src/service.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	roots.push(directory);
	return directory;
}

function captureCliOutput(): { io: EvoCliIO; messages: string[] } {
	const messages: string[] = [];
	return {
		messages,
		io: {
			interactive: false,
			write: (message) => messages.push(message),
			writeError: (message) => messages.push(message),
			question: async () => {
				throw new Error("unexpected interactive prompt");
			},
		},
	};
}

async function seedActiveBundle(root: string) {
	const paths = getEvoPaths(join(root, "evo"));
	const source = join(root, "source");
	await mkdir(join(source, "prompts"), { recursive: true });
	await writeFile(join(source, "prompts", "system.md"), "System prompt\n");
	await writeFile(join(source, "policy.json"), '{ "schemaVersion": 1 }\n');
	const bundle = await compileBundle({ paths, sourceDirectory: source, parentDigest: null, summary: "seed" });
	await new BundleRegistry(paths).initialize(bundle.digest);
	return { paths, service: new EvoService(paths) };
}

describe("evo command surface", () => {
	it("lists templates and writes an importable pack with packs init", async () => {
		const root = await temporary("evo-cmd-packs-");
		const { paths, service } = await seedActiveBundle(root);
		const listing = captureCliOutput();
		await runEvoCli(["packs"], { paths, service, io: listing.io });
		const listed = listing.messages.join("\n");
		expect(listed).toContain("deep-review");
		expect(listed).toContain("deep-research");
		expect(listed).toContain("deepcode");

		const target = join(root, "generated-pack");
		const init = captureCliOutput();
		await runEvoCli(["packs", "init", "deep-research", target], { paths, service, io: init.io });
		expect(init.messages.join("\n")).toContain(target);
		expect((await loadEvoPack(target)).integrity.ok).toBe(true);

		await expect(runEvoCli(["packs", "init", "nope"], { paths, service, io: init.io })).rejects.toThrow(
			"Unknown pack template",
		);
	});

	it("installs a bundled workflow end to end from the parameterless import wizard", async () => {
		const root = await temporary("evo-cmd-import-wizard-");
		const { paths, service } = await seedActiveBundle(root);

		const listing = captureCliOutput();
		await runEvoCli(["import"], { paths, service, io: listing.io, model: "test/model", sandbox: false });
		expect(listing.messages.join("\n")).toContain("可安装的 workflow 模板");

		// Interactive wizard: pick template 3 (deepcode), approve it in one flow.
		const answers = ["3", "a", "y"];
		const messages: string[] = [];
		const io: EvoCliIO = {
			interactive: true,
			write: (message) => messages.push(message),
			writeError: (message) => messages.push(message),
			question: async () => answers.shift() ?? "",
		};
		await runEvoCli(["import"], { paths, service, io, model: "test/model", sandbox: false });
		const output = messages.join("\n");
		expect(output).toContain("可安装的 workflow 模板");
		const kept = (await service.listProposals()).find((entry) => entry.status === "kept");
		expect(kept?.motivation).toContain("deepcode");
		expect(output).toContain("/deepcode 生效");

		// Re-running the wizard now reports deepcode as active.
		const again = captureCliOutput();
		await runEvoCli(["import"], { paths, service, io: again.io, model: "test/model", sandbox: false });
		expect(again.messages.join("\n")).toContain("[已激活] — Multi-agent coding");
	});

	it("imports a workflow pack whose proposal is immediately approvable", async () => {
		const root = await temporary("evo-cmd-import-approve-");
		const { paths, service } = await seedActiveBundle(root);
		const target = join(root, "deepcode-pack");
		const { io } = captureCliOutput();
		await runEvoCli(["packs", "init", "deepcode", target], { paths, service, io });
		await runEvoCli(["import", target], { paths, service, io, model: "test/model", sandbox: false });
		const proposal = (await service.listProposals()).find((entry) => entry.motivation.includes("deepcode"));
		if (!proposal) throw new Error("Imported pack proposal is missing");
		// Import attaches the executable-validation, replay, and review artifacts
		// so the tiered approval checks can actually pass without an evolution run.
		expect(Object.keys(proposal.artifacts)).toEqual(expect.arrayContaining(["validation", "replay", "review"]));
		// Workflows skip the Canary: a dry-run-validated sandboxed command goes
		// live directly (rollbackable, audited as human-direct-keep).
		const approved = await service.approve(proposal.id, proposalApproval(proposal));
		expect(approved.status).toBe("kept");
		const workflows = captureCliOutput();
		await runEvoCli(["workflows"], { paths, service, io: workflows.io });
		expect(workflows.messages.join("\n")).toContain("/deepcode");
	});

	it("reports no active workflows on a fresh bundle", async () => {
		const root = await temporary("evo-cmd-workflows-");
		const { paths, service } = await seedActiveBundle(root);
		const { io, messages } = captureCliOutput();
		await runEvoCli(["workflows"], { paths, service, io });
		expect(messages.join("\n")).toContain("No workflow components are active");
	});

	it("shows and sets whitelisted config keys, rejecting invalid values", async () => {
		const root = await temporary("evo-cmd-config-");
		const { paths, service } = await seedActiveBundle(root);
		const show = captureCliOutput();
		await runEvoCli(["config"], { paths, service, io: show.io });
		expect(show.messages.join("\n")).toContain('"approval": "auto"');

		const set = captureCliOutput();
		await runEvoCli(["config", "set", "grants.approval", "prompt"], { paths, service, io: set.io });
		expect((await readEvoControlConfig(paths)).grants.approval).toBe("prompt");
		await runEvoCli(["config", "set", "triage.everyNSessions", "9"], { paths, service, io: set.io });
		expect((await readEvoControlConfig(paths)).triage.everyNSessions).toBe(9);

		await expect(
			runEvoCli(["config", "set", "grants.approval", "yolo"], { paths, service, io: set.io }),
		).rejects.toThrow("grants.approval");
		await expect(
			runEvoCli(["config", "set", "models.builder.apiKey", "x"], { paths, service, io: set.io }),
		).rejects.toThrow("Unsupported config key");
	});

	it("lists inbox entries with lifecycle status", async () => {
		const root = await temporary("evo-cmd-inbox-");
		const { paths, service } = await seedActiveBundle(root);
		const store = await createRecorderStore({ paths, sessionId: "inbox-session" });
		await store.writeInbox("NOTE: remember to profile the slow path", "interactive", "note");
		const { io, messages } = captureCliOutput();
		await runEvoCli(["inbox"], { paths, service, io });
		const output = messages.join("\n");
		expect(output).toContain("Inbox entries (1)");
		expect(output).toContain("remember to profile the slow path");
	});

	it("shows capability grants with usage against their budgets", async () => {
		const root = await temporary("evo-cmd-grants-");
		const { paths, service } = await seedActiveBundle(root);
		const empty = captureCliOutput();
		await runEvoCli(["grants"], { paths, service, io: empty.io });
		expect(empty.messages.join("\n")).toContain("No components hold capability grants");

		await new EvoCapabilityBroker({ paths }).replaceComponentGrants(
			{
				id: "wf-demo",
				abi: "workflow/v1",
				artifactDigest: "ab".repeat(32),
				declaredCapabilities: ["memory-read"],
				abiCapabilityCeiling: ["memory-read", "memory-write", "spawn-agent"],
			},
			[{ capability: "memory-read", maxCalls: 5 }],
		);
		const listed = captureCliOutput();
		await runEvoCli(["grants"], { paths, service, io: listed.io });
		const output = listed.messages.join("\n");
		expect(output).toContain("wf-demo");
		expect(output).toContain("memory-read: 0/5 calls");

		await expect(runEvoCli(["grants", "extra"], { paths, service, io: listed.io })).rejects.toThrow(
			"Usage: evo-pi grants",
		);
	});

	it("shows the bundle transition history", async () => {
		const root = await temporary("evo-cmd-history-");
		const { paths, service } = await seedActiveBundle(root);
		const { io, messages } = captureCliOutput();
		await runEvoCli(["history"], { paths, service, io });
		const output = messages.join("\n");
		expect(output).toContain("Bundle history");
		expect(output).toContain("initialize");

		await expect(runEvoCli(["history", "soon"], { paths, service, io })).rejects.toThrow("Usage: evo-pi history");
	});

	it("reports triage status and skips a forced run without new sessions", async () => {
		const root = await temporary("evo-cmd-triage-");
		const { paths, service } = await seedActiveBundle(root);
		const status = captureCliOutput();
		await runEvoCli(["triage"], { paths, service, io: status.io });
		const output = status.messages.join("\n");
		expect(output).toContain("Last triage run: never");
		expect(output).toContain("triage now");

		const forced = captureCliOutput();
		await runEvoCli(["triage", "now"], { paths, service, io: forced.io });
		expect(forced.messages.join("\n")).toContain("no new complete sessions");

		await expect(runEvoCli(["triage", "later"], { paths, service, io: forced.io })).rejects.toThrow(
			"Usage: evo-pi triage [now]",
		);
	});

	it("folds scheduled-improve into go --scheduled with the alias intact", async () => {
		const root = await temporary("evo-cmd-go-scheduled-");
		const { paths, service } = await seedActiveBundle(root);
		await writeScheduleConfig(paths, { mode: "manual" });
		const scheduled = captureCliOutput();
		await runEvoCli(["go", "--scheduled"], { paths, service, io: scheduled.io });
		expect(scheduled.messages.at(-1)).toBe("Scheduled improve skipped: manual-mode");

		const alias = captureCliOutput();
		await runEvoCli(["scheduled-improve"], { paths, service, io: alias.io });
		expect(alias.messages).toEqual(scheduled.messages);

		await expect(runEvoCli(["go", "--soon"], { paths, service, io: alias.io })).rejects.toThrow(
			"Usage: evo-pi go [request | --scheduled]",
		);
	});

	it("summarizes model usage and treats workflow as a playbook alias", async () => {
		const root = await temporary("evo-cmd-usage-");
		const { paths, service } = await seedActiveBundle(root);
		const usage = captureCliOutput();
		await runEvoCli(["usage", "30d"], { paths, service, io: usage.io });
		expect(usage.messages.join("\n")).toContain("Model usage over the last 30d");
		await expect(runEvoCli(["usage", "soon"], { paths, service, io: usage.io })).rejects.toThrow("Usage: usage");

		const playbook = captureCliOutput();
		await runEvoCli(["playbook"], { paths, service, io: playbook.io });
		const alias = captureCliOutput();
		await runEvoCli(["workflow"], { paths, service, io: alias.io });
		expect(alias.messages.join("\n")).toBe(playbook.messages.join("\n"));
	});
});
