#!/usr/bin/env node

import { main } from "@earendil-works/pi-coding-agent";
import { createEvoExtension } from "@earendil-works/pi-evo";

process.title = "evo-pi";
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

await main(process.argv.slice(2), {
	extensionFactories: [createEvoExtension()],
});
