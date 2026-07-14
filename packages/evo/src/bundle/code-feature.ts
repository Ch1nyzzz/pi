import type { ExtensionAPI, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getEvoPaths } from "../paths.ts";
import { isEvoFeatureEnabled } from "./feature-gate.ts";

type UntypedHandler = (...args: unknown[]) => unknown;

export interface EvoCodeFeatureAPI {
	on: ExtensionAPI["on"];
	registerTool: ExtensionAPI["registerTool"];
}

export interface EvoCodeFeatureDefinition {
	id: string;
	setup(api: EvoCodeFeatureAPI): void | Promise<void>;
}

const featureToolOwners = new Map<string, Map<string, string>>();

function assertFeatureId(featureId: string): void {
	if (featureId.length === 0) throw new Error("Evo code feature id must not be empty");
}

function claimFeatureTool(root: string, featureId: string, toolName: string): () => void {
	const owners = featureToolOwners.get(root) ?? new Map<string, string>();
	const existing = owners.get(toolName);
	if (existing !== undefined && existing !== featureId) {
		throw new Error(`Evo tool ${toolName} is already owned by code feature ${existing}`);
	}
	if (existing === featureId) return () => {};
	owners.set(toolName, featureId);
	featureToolOwners.set(root, owners);
	return () => {
		const current = featureToolOwners.get(root);
		if (current?.get(toolName) !== featureId) return;
		current.delete(toolName);
		if (current.size === 0) featureToolOwners.delete(root);
	};
}

/** @internal Used by the pinned policy runtime to hide dormant code-feature tools. */
export function filterEvoCodeFeatureTools(
	toolNames: readonly string[],
	enabledFeatures: readonly string[],
	options: { root?: string } = {},
): string[] {
	const owners = featureToolOwners.get(getEvoPaths(options.root).root);
	if (!owners) return [...toolNames];
	const enabled = new Set(enabledFeatures);
	return toolNames.filter((toolName) => {
		const owner = owners.get(toolName);
		return owner === undefined || enabled.has(owner);
	});
}

function sessionIdFromContext(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || !("sessionManager" in value)) return undefined;
	const sessionManager = value.sessionManager;
	if (typeof sessionManager !== "object" || sessionManager === null || !("getSessionId" in sessionManager)) {
		return undefined;
	}
	const getSessionId = sessionManager.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	const sessionId = Reflect.apply(getSessionId, sessionManager, []);
	return typeof sessionId === "string" ? sessionId : undefined;
}

function guardToolDefinition(
	tool: ToolDefinition,
	featureId: string,
	root: string,
	isSessionEnabled: (sessionId: string) => boolean,
): ToolDefinition {
	const prepareArguments = tool.prepareArguments;
	const renderCall = tool.renderCall;
	const renderResult = tool.renderResult;
	const assertEnabledWithoutContext = (): void => {
		if (!isEvoFeatureEnabled(featureId, { root })) {
			throw new Error(`Evo code feature is disabled: ${featureId}`);
		}
	};
	return {
		...tool,
		prepareArguments:
			prepareArguments === undefined
				? undefined
				: (args) => {
						assertEnabledWithoutContext();
						return prepareArguments(args);
					},
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			if (!isSessionEnabled(ctx.sessionManager.getSessionId())) {
				throw new Error(`Evo code feature is disabled for this session: ${featureId}`);
			}
			return tool.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall:
			renderCall === undefined
				? undefined
				: (args, theme, context) => {
						assertEnabledWithoutContext();
						return renderCall(args, theme, context);
					},
		renderResult:
			renderResult === undefined
				? undefined
				: (result, options, theme, context) => {
						assertEnabledWithoutContext();
						return renderResult(result, options, theme, context);
					},
	};
}

function createGuardedOn(pi: ExtensionAPI, isSessionEnabled: (sessionId: string) => boolean): ExtensionAPI["on"] {
	const register = (event: string, handler: UntypedHandler): void => {
		const guarded = (...args: unknown[]): unknown => {
			const sessionId = sessionIdFromContext(args[1]);
			if (sessionId === undefined || !isSessionEnabled(sessionId)) {
				return event === "project_trust" ? { trusted: "undecided" } : undefined;
			}
			return Reflect.apply(handler, undefined, args);
		};
		Reflect.apply(pi.on, pi, [event, guarded]);
	};
	return register as unknown as ExtensionAPI["on"];
}

/**
 * Wrap code-owned tools and hooks so only sessions whose pinned bundle enables
 * the feature id can invoke them. Register this after createPolicyRuntimeExtension;
 * createEvoExtension does that ordering automatically.
 */
export function createEvoCodeFeatureExtension(
	feature: EvoCodeFeatureDefinition,
	options: { root?: string } = {},
): ExtensionFactory {
	assertFeatureId(feature.id);
	const root = getEvoPaths(options.root).root;
	return async (pi) => {
		const enabledSessions = new Set<string>();
		const claims: Array<() => void> = [];
		const isSessionEnabled = (sessionId: string): boolean => enabledSessions.has(sessionId);

		pi.on("session_start", (_event, ctx) => {
			enabledSessions.clear();
			const sessionId = ctx.sessionManager.getSessionId();
			if (isEvoFeatureEnabled(feature.id, { root, sessionId })) enabledSessions.add(sessionId);
		});

		const api: EvoCodeFeatureAPI = {
			on: createGuardedOn(pi, isSessionEnabled),
			registerTool: ((tool: ToolDefinition): void => {
				const release = claimFeatureTool(root, feature.id, tool.name);
				try {
					pi.registerTool(guardToolDefinition(tool, feature.id, root, isSessionEnabled));
					claims.push(release);
				} catch (error) {
					release();
					throw error;
				}
			}) as ExtensionAPI["registerTool"],
		};

		try {
			await feature.setup(api);
		} catch (error) {
			for (const release of claims.reverse()) release();
			throw error;
		}

		pi.on("session_shutdown", (_event, ctx) => {
			enabledSessions.delete(ctx.sessionManager.getSessionId());
		});
	};
}
