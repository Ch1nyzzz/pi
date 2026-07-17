import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import { type EvoCliIO, runEvoCli } from "../src/cli.ts";
import { readEvoControlConfig } from "../src/evolve/config.ts";
import { loadEvoPack } from "../src/pack/pack.ts";
import { getEvoPaths } from "../src/paths.ts";
import { createRecorderStore } from "../src/recorder/store.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
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
