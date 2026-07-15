import { compare, valid } from "semver";
import { VERSION_CHECK_URL } from "../config.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

interface VersionCheckOptions {
	timeoutMs?: number;
	url?: string | null;
}

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: VersionCheckOptions = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) return undefined;
	const url = options.url === null ? undefined : (options.url ?? VERSION_CHECK_URL);
	if (!url) return undefined;

	const response = await fetch(url, {
		headers: {
			"User-Agent": getPiUserAgent(currentVersion),
			accept: "application/json",
		},
		signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS),
	});
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: VersionCheckOptions = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(
	currentVersion: string,
	options: VersionCheckOptions = {},
): Promise<LatestPiRelease | undefined> {
	try {
		const latestRelease = await getLatestPiRelease(currentVersion, options);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
