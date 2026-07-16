import {
	appendFile,
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	stat,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryCapabilityServices } from "../src/components/capabilities/memory.ts";
import type { EvoCapabilityName } from "../src/components/capabilities/protocol.ts";
import type {
	EvoCapabilityComponentIdentity,
	EvoCapabilityServiceContext,
} from "../src/components/capabilities/service.ts";
import { type EvoMemoryFaultPoint, EvoMemoryStore } from "../src/components/memory/store.ts";
import { MEMORY_V1_ABI } from "../src/components/registry.ts";
import { type EvoPaths, getEvoPaths } from "../src/paths.ts";

const roots: string[] = [];
const artifactA = "a".repeat(64);
const artifactB = "b".repeat(64);
const parentBundle = "c".repeat(64);
const trialBundle = "d".repeat(64);
const MEMORY_FAULT_POINTS: readonly EvoMemoryFaultPoint[] = [
	"after-outbox-write",
	"after-pointer-action",
	"after-audit-append",
	"before-outbox-remove",
];
const MEMORY_LIFECYCLE_TRANSITIONS = ["trial", "keep", "rollback", "remove", "reactivate"] as const;
const MEMORY_CRASH_CASES = MEMORY_LIFECYCLE_TRANSITIONS.flatMap((transition) =>
	MEMORY_FAULT_POINTS.map((point) => ({ transition, point })),
);

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; paths: EvoPaths }> {
	const root = await mkdtemp(join(tmpdir(), "pi-evo-memory-store-"));
	roots.push(root);
	return { root, paths: getEvoPaths(join(root, "evo")) };
}

function store(
	paths: EvoPaths,
	componentId = "memory-component",
	artifactDigest = artifactA,
	faultInjection?: (point: EvoMemoryFaultPoint) => void | Promise<void>,
): EvoMemoryStore {
	let event = 0;
	return new EvoMemoryStore({
		paths,
		componentId,
		artifactDigest,
		now: () => "2026-07-16T00:00:00.000Z",
		randomId: () => `event-${++event}`,
		...(faultInjection ? { faultInjection } : {}),
	});
}

function identity(id = "memory-component", artifactDigest = artifactA): EvoCapabilityComponentIdentity {
	return {
		id,
		abi: "memory/v1",
		artifactDigest,
		declaredCapabilities: ["memory-read", "memory-write", "retrieve"],
		abiCapabilityCeiling: ["memory-read", "memory-write", "retrieve"],
	};
}

function context(
	component: EvoCapabilityComponentIdentity,
	capability: Extract<EvoCapabilityName, "memory-read" | "memory-write" | "retrieve">,
): EvoCapabilityServiceContext {
	return { component, capability, signal: new AbortController().signal };
}

describe("Evo component memory store", () => {
	it("persists sorted content-addressed snapshots and audits append, update, and forget", async () => {
		const { paths } = await fixture();
		const memory = store(paths);
		const stable = await memory.initializeStable(parentBundle);
		expect(await stable.read()).toMatchObject({ fragments: [] });

		await stable.append({ id: "zeta", text: "Use tabs", metadata: { kind: "preference" } });
		const second = await stable.append({ id: "alpha", text: "Use the editor formatter" });
		expect((await stable.read()).fragments.map((fragment) => fragment.id)).toEqual(["alpha", "zeta"]);

		const updated = await stable.update(
			{ id: "alpha", text: "Use the editor formatter on save", metadata: { confidence: 1 } },
			second.stateDigest,
		);
		await expect(stable.update({ id: "alpha", text: "Stale update" }, second.stateDigest)).rejects.toThrow(
			"state changed",
		);
		await stable.forget("zeta", updated.stateDigest);
		expect(await stable.read()).toMatchObject({
			fragments: [{ id: "alpha", text: "Use the editor formatter on save", metadata: { confidence: 1 } }],
		});
		expect((await memory.readAudit()).map((entry) => entry.operation)).toEqual([
			"initialize",
			"append",
			"append",
			"update",
			"forget",
		]);

		const current = await stable.read();
		const objectDirectory = join(
			paths.root,
			"component-memory",
			"namespaces",
			"memory-component",
			artifactA,
			"objects",
			"sha256",
		);
		expect((await readdir(objectDirectory)).every((name) => /^[a-f0-9]{64}\.json$/.test(name))).toBe(true);
		await writeFile(
			join(objectDirectory, `${current.stateDigest}.json`),
			`${JSON.stringify({ schemaVersion: 1, fragments: [] })}\n`,
		);
		await expect(stable.read()).rejects.toThrow("digest verification");
	});

	it("isolates state by component id and artifact digest", async () => {
		const { paths } = await fixture();
		const first = store(paths);
		const otherComponent = store(paths, "other-memory-component", artifactA);
		const otherArtifact = store(paths, "memory-component", artifactB);
		const firstStable = await first.initializeStable(parentBundle);
		const componentStable = await otherComponent.initializeStable(parentBundle);
		const artifactStable = await otherArtifact.initializeStable(parentBundle);
		await firstStable.append({ id: "private", text: "Only artifact A may read this" });

		expect((await firstStable.read()).fragments).toHaveLength(1);
		expect((await componentStable.read()).fragments).toEqual([]);
		expect((await artifactStable.read()).fragments).toEqual([]);
		expect(() => store(paths, "../escape", artifactA)).toThrow("component id");
		expect(() => store(paths, "memory-component", "../escape")).toThrow("artifactDigest");
	});

	it("refuses namespace pointer symlinks without reading their targets", async () => {
		const { root, paths } = await fixture();
		const memory = store(paths);
		const stable = await memory.initializeStable(parentBundle);
		const stablePath = join(
			paths.root,
			"component-memory",
			"namespaces",
			"memory-component",
			artifactA,
			"stable.json",
		);
		const outside = join(root, "outside-pointer.json");
		await writeFile(outside, await readFile(stablePath));
		await unlink(stablePath);
		await symlink(outside, stablePath);
		await expect(stable.read()).rejects.toThrow("symbolic links");
	});

	it.each(["intermediate", "namespace"] as const)(
		"rejects a pre-existing %s directory symlink without changing its target",
		async (location) => {
			const { root, paths } = await fixture();
			const memoryRoot = join(paths.root, "component-memory");
			const namespacesRoot = join(memoryRoot, "namespaces");
			const outside = join(root, `outside-${location}`);
			await mkdir(outside, { recursive: true });
			await chmod(outside, 0o750);
			await writeFile(join(outside, "sentinel.txt"), "unchanged\n");
			if (location === "intermediate") {
				await mkdir(memoryRoot, { recursive: true });
				await symlink(outside, namespacesRoot, "dir");
			} else {
				await mkdir(namespacesRoot, { recursive: true });
				await symlink(outside, join(namespacesRoot, "memory-component"), "dir");
			}
			const modeBefore = (await stat(outside)).mode & 0o777;

			await expect(store(paths).initializeStable(parentBundle)).rejects.toThrow(/symbolic links|directory tree/);

			expect((await stat(outside)).mode & 0o777).toBe(modeBefore);
			expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("unchanged\n");
			expect(await readdir(outside)).toEqual(["sentinel.txt"]);
		},
	);

	it("keeps trial writes isolated until explicit promote and discards them on rollback", async () => {
		const { paths } = await fixture();
		const memory = store(paths);
		const stable = await memory.initializeStable(parentBundle);
		await stable.append({ id: "shared", text: "Stable value" });

		const trial = await memory.beginTrial({ parentBundleDigest: parentBundle, trialBundleDigest: trialBundle });
		await trial.update({ id: "shared", text: "Trial value" });
		await trial.append({ id: "trial-only", text: "Trial-only value" });
		expect((await stable.read()).fragments).toMatchObject([{ id: "shared", text: "Stable value" }]);
		expect((await trial.read()).fragments.map((fragment) => fragment.id)).toEqual(["shared", "trial-only"]);

		const rolledBack = await memory.rollbackTrial(trialBundle);
		expect((await rolledBack.read()).fragments).toMatchObject([{ id: "shared", text: "Stable value" }]);
		await expect(memory.openTrial(trialBundle)).rejects.toThrow("not initialized");

		const nextTrial = await memory.beginTrial({ parentBundleDigest: parentBundle, trialBundleDigest: trialBundle });
		await nextTrial.update({ id: "shared", text: "Promoted value" });
		const promoted = await memory.promoteTrial(trialBundle);
		expect((await promoted.read()).fragments).toMatchObject([{ id: "shared", text: "Promoted value" }]);
		await expect(memory.openStable(parentBundle)).rejects.toThrow("not initialized");
		await expect(memory.openTrial(trialBundle)).rejects.toThrow("not initialized");
		expect((await memory.readAudit()).map((entry) => entry.operation)).toEqual([
			"initialize",
			"append",
			"trial-start",
			"update",
			"append",
			"rollback",
			"trial-start",
			"update",
			"promote",
		]);
	});

	it.each(MEMORY_CRASH_CASES)(
		"recovers $transition lifecycle state and audit after $point",
		async ({ transition, point }) => {
			const { paths } = await fixture();
			let armed = false;
			let injectedFailures = 0;
			const memory = store(paths, "memory-component", artifactA, (observed) => {
				if (!armed || observed !== point) return;
				armed = false;
				injectedFailures += 1;
				throw new Error(`injected memory crash at ${point}`);
			});
			await memory.initializeStable(parentBundle);

			let transitionOperation: () => Promise<unknown>;
			if (transition === "trial") {
				transitionOperation = () =>
					memory.beginTrial({ parentBundleDigest: parentBundle, trialBundleDigest: trialBundle });
			} else if (transition === "keep") {
				await memory.beginTrial({ parentBundleDigest: parentBundle, trialBundleDigest: trialBundle });
				transitionOperation = () => memory.promoteTrial(trialBundle);
			} else if (transition === "rollback") {
				await memory.beginTrial({ parentBundleDigest: parentBundle, trialBundleDigest: trialBundle });
				transitionOperation = () => memory.rollbackTrial(trialBundle);
			} else if (transition === "remove") {
				transitionOperation = () =>
					memory.rollbackBundles({
						rolledBackBundleDigests: [parentBundle],
						targetBundleDigest: "e".repeat(64),
						targetAncestorBundleDigests: [],
						targetSelected: false,
					});
			} else {
				await memory.beginTrial({ parentBundleDigest: parentBundle, trialBundleDigest: trialBundle });
				await memory.rollbackTrial(trialBundle);
				transitionOperation = () =>
					memory.beginTrial({ parentBundleDigest: parentBundle, trialBundleDigest: trialBundle });
			}

			armed = true;
			await expect(transitionOperation()).rejects.toThrow(`injected memory crash at ${point}`);
			expect(injectedFailures).toBe(1);
			const audit = await memory.readAudit();
			expect(new Set(audit.map((entry) => entry.eventId)).size).toBe(audit.length);

			if (transition === "keep") {
				await expect(memory.openStable(trialBundle)).resolves.toBeDefined();
				await expect(memory.openTrial(trialBundle)).rejects.toThrow("not initialized");
				expect(audit.filter((entry) => entry.operation === "promote")).toHaveLength(1);
			} else if (transition === "rollback") {
				await expect(memory.openStable(parentBundle)).resolves.toBeDefined();
				await expect(memory.openTrial(trialBundle)).rejects.toThrow("not initialized");
				expect(audit.filter((entry) => entry.operation === "rollback")).toHaveLength(1);
			} else if (transition === "remove") {
				await expect(memory.openStable(parentBundle)).rejects.toThrow("not initialized");
				expect(audit.filter((entry) => entry.operation === "rollback")).toHaveLength(1);
			} else {
				await expect(memory.openTrial(trialBundle)).resolves.toBeDefined();
				expect(audit.filter((entry) => entry.operation === "trial-start")).toHaveLength(
					transition === "reactivate" ? 2 : 1,
				);
			}

			const namespaceRoot = join(paths.root, "component-memory", "namespaces", "memory-component", artifactA);
			expect(await readdir(namespaceRoot)).not.toContain("transaction.json");
		},
	);

	it.each(MEMORY_FAULT_POINTS)("recovers an append mutation and audit after %s", async (point) => {
		const { paths } = await fixture();
		let armed = false;
		const memory = store(paths, "memory-component", artifactA, (observed) => {
			if (!armed || observed !== point) return;
			armed = false;
			throw new Error(`injected memory crash at ${point}`);
		});
		const stable = await memory.initializeStable(parentBundle);
		armed = true;
		await expect(stable.append({ id: "durable", text: "survives a process crash" })).rejects.toThrow(
			`injected memory crash at ${point}`,
		);

		const audit = await memory.readAudit();
		expect(audit.filter((entry) => entry.operation === "append")).toHaveLength(1);
		expect(await stable.read()).toMatchObject({
			fragments: [{ id: "durable", text: "survives a process crash" }],
		});
		expect(await memory.readAudit()).toEqual(audit);
	});

	it("repairs a torn audit tail and does not duplicate an already-appended recovery event", async () => {
		const { paths } = await fixture();
		let armed = false;
		const memory = store(paths, "memory-component", artifactA, (point) => {
			if (!armed || point !== "after-audit-append") return;
			armed = false;
			throw new Error("injected crash after audit append");
		});
		await memory.initializeStable(parentBundle);
		armed = true;
		await expect(
			memory.beginTrial({ parentBundleDigest: parentBundle, trialBundleDigest: trialBundle }),
		).rejects.toThrow("injected crash after audit append");
		const auditPath = join(
			paths.root,
			"component-memory",
			"namespaces",
			"memory-component",
			artifactA,
			"audit.jsonl",
		);
		await appendFile(auditPath, '{"schemaVersion":1,"eventId":"torn');

		const recovered = await memory.readAudit();
		expect(recovered.filter((entry) => entry.operation === "trial-start")).toHaveLength(1);
		expect(await memory.readAudit()).toEqual(recovered);
		expect(await memory.readAudit()).toEqual(recovered);
		expect(await readFile(auditPath, "utf8")).not.toContain('"eventId":"torn');
		expect((await readFile(auditPath, "utf8")).endsWith("\n")).toBe(true);
	});

	it("rejects a conflicting persisted audit entry with a pending event id", async () => {
		const { paths } = await fixture();
		let armed = false;
		const memory = store(paths, "memory-component", artifactA, (point) => {
			if (!armed || point !== "after-outbox-write") return;
			armed = false;
			throw new Error("injected crash after outbox write");
		});
		await memory.initializeStable(parentBundle);
		armed = true;
		await expect(
			memory.beginTrial({ parentBundleDigest: parentBundle, trialBundleDigest: trialBundle }),
		).rejects.toThrow("injected crash after outbox write");
		const namespaceRoot = join(paths.root, "component-memory", "namespaces", "memory-component", artifactA);
		const transaction = JSON.parse(await readFile(join(namespaceRoot, "transaction.json"), "utf8")) as {
			auditEntries: Array<Record<string, unknown>>;
		};
		const pendingEntry = transaction.auditEntries[0];
		if (!pendingEntry) throw new Error("Expected a pending memory audit entry");
		await appendFile(
			join(namespaceRoot, "audit.jsonl"),
			`${JSON.stringify({ ...pendingEntry, stateAfter: "f".repeat(64) })}\n`,
		);

		await expect(memory.readAudit()).rejects.toThrow("has conflicting content");
	});

	it("materializes and rolls back a lineage longer than the outbox action bound", async () => {
		const { paths } = await fixture();
		const memory = store(paths);
		const lineage = Array.from({ length: 21 }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
		const target = lineage[0];
		const ancestor = lineage.at(-1);
		if (!target || !ancestor) throw new Error("Expected a non-empty memory lineage");
		await memory.initializeStable(ancestor);
		await memory.materializeStableForBundle({
			targetBundleDigest: target,
			targetAncestorBundleDigests: lineage.slice(1),
		});
		await expect(memory.openStable(target)).resolves.toBeDefined();

		await memory.rollbackBundles({
			rolledBackBundleDigests: lineage.slice(0, -1),
			targetBundleDigest: ancestor,
			targetAncestorBundleDigests: [],
			targetSelected: true,
		});
		await expect(memory.openStable(ancestor)).resolves.toBeDefined();
		const audit = await memory.readAudit();
		expect(audit.filter((entry) => entry.operation === "promote")).toHaveLength(20);
		expect(audit.filter((entry) => entry.operation === "rollback")).toHaveLength(1);
	});
});

describe("memory capability host services", () => {
	it("maps strict memory/v1 fragments to read/write services and retrieves deterministically", async () => {
		const { paths } = await fixture();
		const memory = store(paths);
		const stable = await memory.initializeStable(parentBundle);
		const services = createMemoryCapabilityServices(stable);
		const component = identity();
		const write = services["memory-write"]!;
		const writeContext = context(component, "memory-write");
		const encoded = MEMORY_V1_ABI.validateOutput({
			mode: "encode",
			writes: [
				{ id: "alpha", text: "editor tabs formatter", metadata: { source: "turn-1" } },
				{ id: "beta", text: "editor spaces" },
				{ id: "gamma", text: "tabs" },
			],
			updates: [],
			forgets: [],
		});
		if (encoded.mode !== "encode") throw new Error("Expected memory/v1 encode output");
		for (const fragment of encoded.writes) {
			const request = write.prepare({ operation: "append", fragment }, writeContext);
			await write.execute(request.request, writeContext);
		}

		const read = services["memory-read"]!;
		const readContext = context(component, "memory-read");
		const list = read.prepare({ operation: "list" }, readContext);
		await expect(read.execute(list.request, readContext)).resolves.toMatchObject({
			result: { fragments: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] },
		});
		const get = read.prepare({ operation: "get", id: "beta" }, readContext);
		await expect(read.execute(get.request, readContext)).resolves.toMatchObject({
			result: { fragment: { id: "beta", text: "editor spaces" } },
		});

		const retrieve = services.retrieve!;
		const retrieveContext = context(component, "retrieve");
		const retrieval = retrieve.prepare({ query: "editor tabs", limit: 3 }, retrieveContext);
		await expect(retrieve.execute(retrieval.request, retrieveContext)).resolves.toMatchObject({
			result: {
				fragments: [
					{ id: "alpha", score: 2 },
					{ id: "beta", score: 1 },
					{ id: "gamma", score: 1 },
				],
			},
		});
	});

	it("rejects cross-artifact access, unknown fields, and stale writes", async () => {
		const { paths } = await fixture();
		const memory = store(paths);
		const stable = await memory.initializeStable(parentBundle);
		const services = createMemoryCapabilityServices(stable);
		const write = services["memory-write"]!;
		const writeContext = context(identity(), "memory-write");
		const initial = await stable.read();
		const append = write.prepare(
			{
				operation: "append",
				fragment: { id: "one", text: "First fragment" },
				expectedStateDigest: initial.stateDigest,
			},
			writeContext,
		);
		await write.execute(append.request, writeContext);

		const stale = write.prepare(
			{
				operation: "update",
				fragment: { id: "one", text: "Stale fragment" },
				expectedStateDigest: initial.stateDigest,
			},
			writeContext,
		);
		await expect(write.execute(stale.request, writeContext)).rejects.toThrow("state changed");
		expect(() =>
			write.prepare(
				{ operation: "append", fragment: { id: "two", text: "Second", path: "../escape" } },
				writeContext,
			),
		).toThrow("unknown key");
		expect(() =>
			services["memory-read"]!.prepare(
				{ operation: "list", namespace: "other" },
				context(identity(), "memory-read"),
			),
		).toThrow("unknown key");
		expect(() =>
			services.retrieve!.prepare({ query: "fragment", limit: 0 }, context(identity(), "retrieve")),
		).toThrow("integer from 1");
		expect(() =>
			write.prepare(
				{ operation: "forget", id: "one" },
				context(identity("memory-component", artifactB), "memory-write"),
			),
		).toThrow("not assigned");

		const current = await stable.read();
		const forget = write.prepare(
			{ operation: "forget", id: "one", expectedStateDigest: current.stateDigest },
			writeContext,
		);
		await expect(write.execute(forget.request, writeContext)).resolves.toMatchObject({
			result: { forgottenId: "one" },
		});
		expect((await memory.readAudit()).map((entry) => entry.operation)).toEqual(["initialize", "append", "forget"]);
	});

	it("stores no caller-selected path in persisted namespace pointers", async () => {
		const { paths } = await fixture();
		const memory = store(paths);
		await memory.initializeStable(parentBundle);
		const stablePath = join(
			paths.root,
			"component-memory",
			"namespaces",
			"memory-component",
			artifactA,
			"stable.json",
		);
		const pointer = JSON.parse(await readFile(stablePath, "utf8")) as unknown;
		expect(pointer).toEqual({
			schemaVersion: 1,
			kind: "stable",
			bundleDigest: parentBundle,
			parentBundleDigest: null,
			stateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
	});
});
