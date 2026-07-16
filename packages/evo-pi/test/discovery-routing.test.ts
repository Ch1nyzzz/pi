import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Evo-Pi discovery routing", () => {
	it.each([
		["search", ["search"]],
		["install", ["install", "missing-pack"]],
	])("routes public %s through the administrative CLI", (_label, args) => {
		const agentDir = mkdtempSync(join(tmpdir(), "evo-pi-discovery-routing-"));
		roots.push(agentDir);
		const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
			cwd: join(import.meta.dirname, ".."),
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
			encoding: "utf8",
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("pack discovery config not found");
		expect(result.stdout).not.toContain("Evo-Pi - AI coding assistant");
	});
});
