import { afterEach, describe, expect, it } from "vitest";
import type { LoadedEvoComponentArtifact } from "../src/components/artifact.ts";
import { dockerSandboxCommand } from "../src/components/process-runtime.ts";

const artifact: LoadedEvoComponentArtifact = {
	directory: "/evo/components/sha256/abc",
	entrypoint: "/evo/components/sha256/abc/component.mjs",
	manifest: {
		schemaVersion: 1,
		id: "cache-anchor-append-compaction",
		version: "1.0.0",
		artifactDigest: "abc",
		entrypointSha256: "def",
		abi: "compaction/v1",
		activationBoundary: "session",
		capabilities: [],
		entrypoint: "component.mjs",
	},
};

afterEach(() => {
	delete process.env.PI_EVO_DOCKER_IMAGE;
});

describe("docker component sandbox", () => {
	it("launches the artifact in a fully isolated container", () => {
		const launch = dockerSandboxCommand(artifact);

		expect(launch.command).toBe("docker");
		expect(launch.args).toEqual(
			expect.arrayContaining([
				"--network=none",
				"--read-only",
				"--cap-drop=ALL",
				"--security-opt=no-new-privileges",
				"--interactive",
			]),
		);
		expect(launch.args).toContain(`${artifact.directory}:/component:ro`);
		expect(launch.args.at(-2)).toBe("node");
		expect(launch.args.at(-1)).toBe("/component/component.mjs");
	});

	it("honours the image override for air-gapped hosts", () => {
		process.env.PI_EVO_DOCKER_IMAGE = "registry.internal/node:22";

		expect(dockerSandboxCommand(artifact).args).toContain("registry.internal/node:22");
	});
});
