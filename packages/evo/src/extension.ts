import type { ExtensionFactory } from "@ch1nyzzz/pi-coding-agent";
import { createEvoAutoImproveExtension } from "./auto-improve.ts";
import { createEvoCodeFeatureExtension, type EvoCodeFeatureDefinition } from "./bundle/code-feature.ts";
import { createPolicyRuntimeExtension, type EvoPolicyRuntimeOptions } from "./bundle/runtime.ts";
import { createEvoCommandExtension, type EvoCommandExtensionOptions } from "./cli.ts";
import { getEvoPaths } from "./paths.ts";
import { createRecorderExtension } from "./recorder/extension.ts";
import { EvoService } from "./service.ts";

export interface EvoAutoImproveTuning {
	initialDelayMs?: number;
	checkIntervalMs?: number;
}

export type EvoExtensionOptions = EvoCommandExtensionOptions &
	EvoPolicyRuntimeOptions & {
		codeFeatures?: readonly EvoCodeFeatureDefinition[];
		autoImprove?: EvoAutoImproveTuning | false;
	};

export function createEvoExtension(options: EvoExtensionOptions = {}): ExtensionFactory {
	const paths = options.service?.paths ?? options.paths ?? getEvoPaths(options.root);
	const service = options.service ?? new EvoService(paths);
	const policyRuntime = createPolicyRuntimeExtension({ ...options, root: paths.root });
	const recorder = createRecorderExtension({ paths });
	const commands = createEvoCommandExtension({
		...options,
		paths,
		service,
		spawnAgentToolNames: options.spawnAgentToolNames ?? options.spawnAgentTools?.map((tool) => tool.name),
	});
	const autoImprove =
		options.autoImprove === false
			? undefined
			: createEvoAutoImproveExtension({ ...options, paths, service, ...options.autoImprove });

	return async (pi) => {
		// ExtensionRunner chains before_agent_start results in registration order.
		// Policy therefore mutates the effective prompt before Recorder observes it.
		await policyRuntime(pi);
		for (const feature of options.codeFeatures ?? []) {
			await createEvoCodeFeatureExtension(feature, { root: paths.root })(pi);
		}
		await recorder(pi);
		await commands(pi);
		if (autoImprove) await autoImprove(pi);
	};
}

export default createEvoExtension();
