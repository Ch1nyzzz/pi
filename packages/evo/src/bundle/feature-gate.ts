import { getEvoPaths } from "../paths.ts";

export interface EvoFeatureGateOptions {
	root?: string;
	sessionId?: string;
}

const activeSessions = new Map<string, Map<string, ReadonlySet<string>>>();

function resolveGateRoot(options: EvoFeatureGateOptions): string {
	return getEvoPaths(options.root).root;
}

export function isEvoFeatureEnabled(featureId: string, options: EvoFeatureGateOptions = {}): boolean {
	const sessions = activeSessions.get(resolveGateRoot(options));
	if (!sessions) return false;
	if (options.sessionId !== undefined) return sessions.get(options.sessionId)?.has(featureId) ?? false;
	if (sessions.size !== 1) return false;
	const features = sessions.values().next().value;
	return features?.has(featureId) ?? false;
}

export function guardEvoFeature(featureId: string, options: EvoFeatureGateOptions = {}): boolean {
	return isEvoFeatureEnabled(featureId, options);
}

export function createEvoFeatureHandler<Arguments extends readonly unknown[], Result>(
	featureId: string,
	handler: (...args: Arguments) => Result,
	options: EvoFeatureGateOptions = {},
): (...args: Arguments) => Result | undefined {
	return (...args) => {
		if (!guardEvoFeature(featureId, options)) return undefined;
		return handler(...args);
	};
}

/** @internal Used by the policy runtime to bind feature flags to one pinned session. */
export function activateEvoFeatureSession(
	enabledFeatures: readonly string[],
	options: EvoFeatureGateOptions & { sessionId: string },
): () => void {
	const root = resolveGateRoot(options);
	const sessions = activeSessions.get(root) ?? new Map<string, ReadonlySet<string>>();
	const features = new Set(enabledFeatures);
	sessions.set(options.sessionId, features);
	activeSessions.set(root, sessions);
	return () => {
		const current = activeSessions.get(root);
		if (current?.get(options.sessionId) !== features) return;
		current.delete(options.sessionId);
		if (current.size === 0) activeSessions.delete(root);
	};
}
