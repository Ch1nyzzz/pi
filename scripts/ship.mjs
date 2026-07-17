#!/usr/bin/env node

/**
 * One-command release: bump the lockstep patch version, regenerate the
 * coding-agent lockfiles, create the release commit, publish every package,
 * and push the mirror. Run it AFTER the feature/fix commits are already made;
 * it refuses to fold unrelated dirty files into the release commit.
 *
 *   npm run ship             # full flow
 *   npm run ship -- --no-push  # skip the mirror push
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const noPush = process.argv.includes("--no-push");
const unknownArgs = process.argv.slice(2).filter((arg) => arg !== "--no-push");
if (unknownArgs.length > 0) {
	console.error(`Unknown arguments: ${unknownArgs.join(" ")}`);
	process.exit(1);
}

function run(command, args, options = {}) {
	console.log(`\n$ ${command} ${args.join(" ")}`);
	const result = spawnSync(command, args, { stdio: "inherit", ...options });
	if (result.status !== 0) {
		console.error(`\nship: '${command} ${args.join(" ")}' failed (exit ${result.status ?? "signal"})`);
		process.exit(result.status ?? 1);
	}
}

function capture(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) {
		console.error(result.stderr || `ship: '${command} ${args.join(" ")}' failed`);
		process.exit(result.status ?? 1);
	}
	return result.stdout.trim();
}

// Node >= 22.20 is required: older 22.x cannot spawn the .ts CLI entrypoints
// that several test suites and generated tools rely on.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 20)) {
	console.error(`ship: Node ${process.versions.node} is too old; use >= 22.20 (nvm use 22.20.0)`);
	process.exit(1);
}

// Refuse to release from a dirty tree: feature commits must land first so the
// release commit contains only version/lockfile churn.
const dirty = capture("git", ["status", "--porcelain"]);
if (dirty) {
	console.error("ship: working tree is dirty; commit or stash these files first:\n" + dirty);
	process.exit(1);
}

run("npm", ["run", "version:patch"]);
run("npm", ["run", "shrinkwrap:coding-agent"]);
run("npm", ["run", "install-lock:coding-agent"]);

const version = JSON.parse(readFileSync("packages/evo/package.json", "utf8")).version;
run("git", ["add", "-A"]);
run("git", ["commit", "-m", `Release v${version}`], {
	env: { ...process.env, PI_ALLOW_LOCKFILE_CHANGE: "1" },
});

run("npm", ["run", "publish"]);

if (noPush) {
	console.log(`\nship: v${version} published; skipped 'git push mirror main' (--no-push)`);
} else {
	run("git", ["push", "mirror", "main"]);
	console.log(`\nship: v${version} published and pushed`);
}
