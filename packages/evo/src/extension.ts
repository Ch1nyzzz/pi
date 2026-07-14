import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createPolicyRuntimeExtension } from "./bundle/runtime.ts";
import { createEvoCommandExtension, type EvoCommandExtensionOptions } from "./cli.ts";
import { getEvoPaths } from "./paths.ts";
import { createRecorderExtension } from "./recorder/extension.ts";
import { EvoService } from "./service.ts";

export type EvoExtensionOptions = EvoCommandExtensionOptions;

export function createEvoExtension(options: EvoExtensionOptions = {}): ExtensionFactory {
	const paths = options.service?.paths ?? options.paths ?? getEvoPaths(options.root);
	const service = options.service ?? new EvoService(paths);
	const policyRuntime = createPolicyRuntimeExtension({ root: paths.root });
	const recorder = createRecorderExtension({ paths });
	const commands = createEvoCommandExtension({ ...options, paths, service });

	return async (pi) => {
		// ExtensionRunner chains before_agent_start results in registration order.
		// Policy therefore mutates the effective prompt before Recorder observes it.
		await policyRuntime(pi);
		await recorder(pi);
		await commands(pi);
	};
}

export default createEvoExtension();
