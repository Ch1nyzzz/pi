#!/usr/bin/env node

import { main } from "@ch1nyzzz/pi-coding-agent";
import { createEvoExtension } from "@ch1nyzzz/pi-evo";

process.title = "evo-pi";
process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

await main(process.argv.slice(2), {
	extensionFactories: [createEvoExtension()],
});
