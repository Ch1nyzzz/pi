import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

function run(entrypoint: string, args: string[], agentDir: string) {
	return spawnSync(process.execPath, ["--import", "tsx", entrypoint, ...args], {
		cwd: join(import.meta.dirname, ".."),
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
		encoding: "utf8",
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Evo-Pi distribution", () => {
	it("exposes the branded interactive entry point", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "evo-pi-product-"));
		roots.push(agentDir);

		const result = run("src/cli.ts", ["--help"], agentDir);

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Evo-Pi - AI coding assistant");
		expect(result.stdout).toContain("evo-pi [options]");
		expect(result.stderr).toBe("");
	});

	it("initializes personal evolution state outside the product package", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "evo-pi-personal-state-"));
		roots.push(agentDir);

		const result = run("src/admin.ts", ["init"], agentDir);

		expect(result.status).toBe(0);
		const stable = readFileSync(join(agentDir, "evo", "registry", "stable"), "utf8").trim();
		expect(stable).toMatch(/^[a-f0-9]{64}$/);
		expect(result.stdout).toContain(stable);
	});
});
