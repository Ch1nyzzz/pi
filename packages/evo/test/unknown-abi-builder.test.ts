import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileBundle } from "../src/bundle/compile.ts";
import type { CodeL1Result, CodeValidationContext, CodeValidationExecutor } from "../src/code/worktree.ts";
import { publishEvoComponentArtifact } from "../src/components/artifact.ts";
import type { EvoCapabilityGrant } from "../src/components/capabilities/broker.ts";
import { parseUnknownAbiBuilderSubmission } from "../src/evolve/builder.ts";
import { runUnknownAbiBuilderCycle } from "../src/evolve/cycle.ts";
import {
	assertUnknownAbiCodePatch,
	createUnknownAbiBuilderRequestsFromPack,
	parseUnknownAbiBuilderRequest,
	type UnknownAbiBuilderRequest,
} from "../src/evolve/unknown-abi.ts";
import { computeEvoPackIntegrity, parseEvoPackManifest } from "../src/pack/pack.ts";
import { getEvoPaths } from "../src/paths.ts";
import type { ModelRunner, ModelRunRequest, ModelRunResult } from "../src/reflect/model-runner.ts";
import { BundleRegistry } from "../src/registry/registry.ts";
import type { EvoControlConfig } from "../src/types.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const inferGrant: EvoCapabilityGrant = {
	capability: "infer",
	maxCalls: 2,
	models: ["fake/model"],
	maxInputTokens: 2_000,
	maxOutputTokens: 1_000,
	maxTotalTokens: 3_000,
	maxCostUsd: 1,
	maxOutputTokensPerCall: 500,
};

const componentSource = `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "invoke") {
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { text: request.payload.text } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: {} }) + "\\n");
});
`;

function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function replacementPatch(path: string, before: string, after: string): string {
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		"@@ -1 +1 @@",
		`-${before}`,
		`+${after}`,
		"",
	].join("\n");
}

function validPatch(): string {
	return [
		replacementPatch(
			"packages/evo/src/components/registry.ts",
			"export const registry = 1;",
			'export const INVENTED_V1_ABI: EvoAbiDefinition = { id: "invented/v1", capabilityCeiling: ["infer"] };',
		),
		replacementPatch(
			"packages/evo/src/bundle/runtime.ts",
			"export const runtime = 1;",
			'export const runtime = "invented/v1";',
		),
		replacementPatch(
			"packages/evo/test/invented-abi.test.ts",
			"export const covered = false;",
			'export const covered = "invented/v1";',
		),
	].join("");
}

async function makePack(root: string): Promise<string> {
	const packDirectory = join(root, "pack");
	const artifactPaths = getEvoPaths(join(root, "artifact-evo"));
	const artifact = await publishEvoComponentArtifact(artifactPaths, {
		id: "invented-component",
		version: "1.0.0",
		abi: "invented/v1",
		activationBoundary: "invocation",
		capabilities: ["infer"],
		entrypointContent: componentSource,
	});
	const packArtifact = join(packDirectory, "components", "invented-component");
	await mkdir(packArtifact, { recursive: true });
	await writeFile(join(packArtifact, "manifest.json"), await readFile(join(artifact.directory, "manifest.json")));
	await writeFile(join(packArtifact, artifact.manifest.entrypoint), await readFile(artifact.entrypoint));
	const base = {
		packFormat: 1,
		name: "invented-pack",
		version: "1.0.0",
		contents: {
			components: [
				{
					surface: "invented",
					abi: "invented/v1",
					id: "invented-component",
					artifact: "components/invented-component",
					capabilities: ["infer"],
				},
			],
		},
		requiresAbis: ["invented/v1"],
		requiresCapabilities: ["infer"],
	};
	const integrity = await computeEvoPackIntegrity(packDirectory, parseEvoPackManifest(base));
	await writeFile(join(packDirectory, "pack.json"), `${JSON.stringify({ ...base, integrity }, undefined, "\t")}\n`);
	return packDirectory;
}

async function makeRequest(root: string): Promise<UnknownAbiBuilderRequest> {
	const packDirectory = await makePack(root);
	const requests = await createUnknownAbiBuilderRequestsFromPack({
		packDirectory,
		grantsByComponent: { "invented-component": [inferGrant] },
	});
	if (!requests[0]) throw new Error("Unknown ABI request was not created");
	return requests[0];
}

async function makeRepository(root: string): Promise<string> {
	const repository = join(root, "repository");
	await mkdir(join(repository, "packages", "evo", "src", "components"), { recursive: true });
	await mkdir(join(repository, "packages", "evo", "src", "bundle"), { recursive: true });
	await mkdir(join(repository, "packages", "evo", "test"), { recursive: true });
	await writeFile(
		join(repository, "packages", "evo", "src", "components", "registry.ts"),
		"export const registry = 1;\n",
	);
	await writeFile(join(repository, "packages", "evo", "src", "bundle", "runtime.ts"), "export const runtime = 1;\n");
	await writeFile(
		join(repository, "packages", "evo", "test", "invented-abi.test.ts"),
		"export const covered = false;\n",
	);
	git(repository, ["init", "--quiet"]);
	git(repository, ["config", "user.name", "Evo Test"]);
	git(repository, ["config", "user.email", "evo-test@example.invalid"]);
	git(repository, ["add", "packages/evo/src/components/registry.ts"]);
	git(repository, ["add", "packages/evo/src/bundle/runtime.ts"]);
	git(repository, ["add", "packages/evo/test/invented-abi.test.ts"]);
	git(repository, ["commit", "--quiet", "-m", "initial"]);
	return repository;
}

class PassingValidator implements CodeValidationExecutor {
	readonly calls: CodeValidationContext[] = [];

	async validate(context: CodeValidationContext): Promise<CodeL1Result> {
		this.calls.push(context);
		return { passed: true, errors: [], checks: [] };
	}
}

class FakeBuilderRunner implements ModelRunner {
	request?: ModelRunRequest;

	async run(request: ModelRunRequest): Promise<ModelRunResult> {
		this.request = request;
		const raw = {
			observationsMarkdown: "# ABI inspection\n\nThe component implements the invented surface.",
			proposal: {
				motivation: "Host the integrity-pinned invented component.",
				expectedEffect: "Register a strict invented/v1 host surface.",
				risk: "A new host boundary requires explicit code review.",
				verifyPlan: "Run repository checks and focused ABI fixtures.",
				codePatch: validPatch(),
			},
		};
		const submission = request.submission?.validate?.(raw) ?? raw;
		return {
			text: "",
			submission,
			model: { provider: "fake", id: request.model ?? "fake/model" },
			stats: {
				sessionFile: undefined,
				sessionId: "unknown-abi-builder",
				userMessages: 1,
				assistantMessages: 1,
				toolCalls: 1,
				toolResults: 1,
				totalMessages: 4,
				tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, total: 20 },
				cost: 0,
			},
		};
	}
}

const config: EvoControlConfig = {
	schemaVersion: 1,
	models: {
		researchPlanner: { model: "fake/research" },
		builder: { model: "fake/builder" },
		evaluator: { model: "fake/evaluator" },
		triage: { model: "fake/luna" },
	},
	release: {
		autoApplyT0: false,
		autoStartDataTrial: false,
		autoStartComponentTrial: false,
		autoKeepSuccessfulTrial: false,
	},
	grants: {
		approval: "auto",
	},
	verification: {
		approval: "ask",
	},
	triage: {
		everyNSessions: 5,
	},
};

describe("unregistered ABI Builder path", () => {
	it("freezes the future selection with exact explicit grants", async () => {
		const root = await mkdtemp(join(tmpdir(), "evo-unknown-abi-request-"));
		roots.push(root);
		const packDirectory = await makePack(root);
		const [request] = await createUnknownAbiBuilderRequestsFromPack({
			packDirectory,
			grantsByComponent: { "invented-component": [inferGrant] },
		});

		expect(request?.targetAbi).toBe("invented/v1");
		expect(request?.capabilityCeiling).toEqual(["infer"]);
		expect(request?.parts[0]?.selection.grants).toEqual([inferGrant]);
		expect(request?.parts[0]?.entrypointContent).toBe(componentSource);
		await expect(createUnknownAbiBuilderRequestsFromPack({ packDirectory })).rejects.toThrow(
			"must explicitly grant exactly the declared capability set",
		);
		expect(() => parseUnknownAbiBuilderRequest({ ...request, unexpected: true })).toThrow("unknown key");
	});

	it("rejects schema drift, forbidden paths, selection embedding, and oversized output", async () => {
		const root = await mkdtemp(join(tmpdir(), "evo-unknown-abi-output-"));
		roots.push(root);
		const request = await makeRequest(root);
		const output = {
			observationsMarkdown: "Bounded observations.",
			proposal: {
				motivation: "Add the missing ABI.",
				expectedEffect: "Host the component.",
				risk: "New host wiring.",
				verifyPlan: "Run focused tests.",
				codePatch: validPatch(),
			},
		};

		expect(parseUnknownAbiBuilderSubmission(output, request).proposal.codePatch).toBe(validPatch());
		expect(() => parseUnknownAbiBuilderSubmission({ ...output, approval: true }, request)).toThrow("unknown key");
		expect(() =>
			assertUnknownAbiCodePatch(
				request,
				validPatch().replaceAll(
					"packages/evo/test/invented-abi.test.ts",
					"packages/evo/src/components/capabilities/broker.ts",
				),
			),
		).toThrow("forbidden path");
		expect(() =>
			assertUnknownAbiCodePatch(
				request,
				validPatch().replace('capabilityCeiling: ["infer"]', 'capabilityCeiling: ["infer", "exec"]'),
			),
		).toThrow("widens or narrows");
		expect(() =>
			assertUnknownAbiCodePatch(request, `${validPatch()}+${request.parts[0]?.selection.artifactDigest}\n`),
		).toThrow("must not hard-code");
		expect(() =>
			parseUnknownAbiBuilderSubmission(
				{
					...output,
					observationsMarkdown: "x".repeat(16 * 1024 + 1),
				},
				request,
			),
		).toThrow("exceeds");
	});

	it("persists an audited run and registers a pending T2 proposal without writing broker state", async () => {
		const root = await mkdtemp(join(tmpdir(), "evo-unknown-abi-cycle-"));
		roots.push(root);
		const request = await makeRequest(root);
		const repository = await makeRepository(root);
		const paths = getEvoPaths(join(root, "evo"));
		const seed = join(root, "seed");
		await mkdir(seed);
		await writeFile(join(seed, "policy.json"), '{ "schemaVersion": 1 }\n');
		const bundle = await compileBundle({
			paths,
			sourceDirectory: seed,
			parentDigest: null,
			summary: "unknown ABI seed",
		});
		await new BundleRegistry(paths).initialize(bundle.digest);
		const runner = new FakeBuilderRunner();
		const validator = new PassingValidator();

		const result = await runUnknownAbiBuilderCycle({
			paths,
			request,
			parentDigest: bundle.digest,
			runner,
			cwd: repository,
			config,
			codeValidationExecutor: validator,
		});

		expect(result.run.status).toBe("awaiting-decision");
		expect(result.proposal).toMatchObject({
			kind: "code",
			tier: "T2",
			status: "pending",
			targetAbi: "invented/v1",
			requiresNewAbi: true,
		});
		expect(result.nextAction).toContain("retry");
		expect(validator.calls).toHaveLength(1);
		expect(runner.request?.tools).toEqual(["read", "grep", "find", "ls"]);
		expect(runner.request?.prompt).toContain('"grants":[{"capability":"infer"');
		expect(runner.request?.prompt).toContain('"maxOutputTokensPerCall":500');
		const runDirectory = join(paths.runs, result.run.id);
		const auditedRequest = JSON.parse(await readFile(join(runDirectory, "unknown-abi-request.json"), "utf8"));
		expect(auditedRequest.parts[0].selection.grants).toEqual([inferGrant]);
		expect(JSON.parse(await readFile(join(runDirectory, "plan.json"), "utf8"))).toMatchObject({
			targetAbi: "invented/v1",
			requiresNewAbi: true,
			candidateKind: "code",
		});
		await expect(readFile(join(paths.registry, "capability-grants.json"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		await expect(
			runUnknownAbiBuilderCycle({
				paths,
				request,
				parentDigest: bundle.digest,
				runner,
				cwd: repository,
				config,
				codeValidationExecutor: validator,
			}),
		).rejects.toThrow("already has proposal");
		expect(validator.calls).toHaveLength(1);
	});
});
