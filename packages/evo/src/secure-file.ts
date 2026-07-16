import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWriteFile, durableUnlink } from "./storage.ts";

const COPY_BUFFER_BYTES = 64 * 1024;

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function assertUnchanged(before: Stats, after: Stats, label: string): void {
	if (
		!after.isFile() ||
		!sameIdentity(before, after) ||
		before.size !== after.size ||
		before.mtimeMs !== after.mtimeMs ||
		before.ctimeMs !== after.ctimeMs
	) {
		throw new Error(`${label} changed while it was read`);
	}
}

function noFollowFlags(label: string): number {
	if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) {
		throw new Error(`${label} cannot be opened because atomic no-follow reads are unsupported`);
	}
	return constants.O_RDONLY | constants.O_NOFOLLOW;
}

function noFollowDirectoryFlags(label: string): number {
	if (
		!Number.isInteger(constants.O_NOFOLLOW) ||
		constants.O_NOFOLLOW === 0 ||
		!Number.isInteger(constants.O_DIRECTORY) ||
		constants.O_DIRECTORY === 0
	) {
		throw new Error(`${label} cannot be opened because descriptor-relative directory access is unsupported`);
	}
	return constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
}

function descriptorDirectoryPath(handle: Awaited<ReturnType<typeof open>>, label: string): string {
	if (process.platform !== "linux") {
		throw new Error(`${label} cannot be accessed safely because descriptor-relative paths are unsupported`);
	}
	return `/proc/self/fd/${handle.fd}`;
}

async function withRegularDirectoryNoFollow<T>(
	path: string,
	label: string,
	operation: (descriptorPath: string, status: Stats) => Promise<T>,
): Promise<T> {
	const absolutePath = resolve(path);
	const pathStatus = await lstat(absolutePath);
	if (!pathStatus.isDirectory() || pathStatus.isSymbolicLink()) {
		throw new Error(`${label} must be a regular directory without symbolic links`);
	}
	if ((await realpath(absolutePath)) !== absolutePath) throw new Error(`${label} traverses a symbolic link`);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(absolutePath, noFollowDirectoryFlags(label));
	} catch (error) {
		if (["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error) ?? "")) {
			throw new Error(`${label} cannot be opened with descriptor-relative no-follow protection`, { cause: error });
		}
		if (errorCode(error) === "ELOOP") {
			throw new Error(`${label} must be a regular directory without symbolic links`, { cause: error });
		}
		throw error;
	}
	try {
		const before = await handle.stat();
		if (!before.isDirectory() || !sameIdentity(pathStatus, before)) {
			throw new Error(`${label} changed during validation`);
		}
		const descriptorPath = descriptorDirectoryPath(handle, label);
		if ((await realpath(descriptorPath)) !== absolutePath)
			throw new Error(`${label} descriptor changed during validation`);
		const result = await operation(descriptorPath, before);
		await handle.sync();
		const after = await handle.stat();
		const finalPathStatus = await lstat(absolutePath);
		if (
			!after.isDirectory() ||
			!finalPathStatus.isDirectory() ||
			finalPathStatus.isSymbolicLink() ||
			!sameIdentity(before, after) ||
			!sameIdentity(before, finalPathStatus) ||
			(await realpath(absolutePath)) !== absolutePath
		) {
			throw new Error(`${label} changed while it was accessed`);
		}
		return result;
	} finally {
		await handle.close();
	}
}

async function withRegularFileNoFollow<T>(
	path: string,
	label: string,
	operation: (handle: Awaited<ReturnType<typeof open>>, status: Stats) => Promise<T>,
): Promise<T> {
	const absolutePath = resolve(path);
	const pathStatus = await lstat(absolutePath);
	if (!pathStatus.isFile() || pathStatus.isSymbolicLink()) {
		throw new Error(`${label} must be a regular file without symbolic links`);
	}
	if ((await realpath(absolutePath)) !== absolutePath) {
		throw new Error(`${label} traverses a symbolic link`);
	}

	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(absolutePath, noFollowFlags(label));
	} catch (error) {
		if (["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error) ?? "")) {
			throw new Error(`${label} cannot be opened with atomic no-follow protection`, { cause: error });
		}
		if (errorCode(error) === "ELOOP") {
			throw new Error(`${label} must be a regular file without symbolic links`, { cause: error });
		}
		throw error;
	}
	try {
		const before = await handle.stat();
		if (!before.isFile() || !sameIdentity(pathStatus, before)) {
			throw new Error(`${label} changed during validation`);
		}
		const result = await operation(handle, before);
		assertUnchanged(before, await handle.stat(), label);
		const finalPathStatus = await lstat(absolutePath);
		if (
			!finalPathStatus.isFile() ||
			finalPathStatus.isSymbolicLink() ||
			!sameIdentity(before, finalPathStatus) ||
			(await realpath(absolutePath)) !== absolutePath
		) {
			throw new Error(`${label} changed while it was read`);
		}
		return result;
	} finally {
		await handle.close();
	}
}

/** Resolve one directory once while rejecting a final-component symlink or identity race. */
export async function resolveRegularDirectory(path: string, label: string): Promise<string> {
	const absolutePath = resolve(path);
	const initial = await lstat(absolutePath);
	if (!initial.isDirectory() || initial.isSymbolicLink()) {
		throw new Error(`${label} must be a regular directory`);
	}
	const canonicalPath = await realpath(absolutePath);
	const confirmed = await lstat(absolutePath);
	const canonical = await lstat(canonicalPath);
	if (
		!confirmed.isDirectory() ||
		confirmed.isSymbolicLink() ||
		!canonical.isDirectory() ||
		canonical.isSymbolicLink() ||
		!sameIdentity(initial, confirmed) ||
		!sameIdentity(confirmed, canonical)
	) {
		throw new Error(`${label} changed during validation`);
	}
	return canonicalPath;
}

async function nearestExistingDirectory(path: string, label: string): Promise<string> {
	let candidate = dirname(resolve(path));
	while (true) {
		try {
			const status = await lstat(candidate);
			if (!status.isDirectory() || status.isSymbolicLink()) {
				throw new Error(`${label} ancestor must be a regular directory without symbolic links`);
			}
			return candidate;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		const parent = dirname(candidate);
		if (parent === candidate) throw new Error(`${label} has no existing directory anchor`);
		candidate = parent;
	}
}

async function ensureDirectoryDescendantsNoFollow(
	anchorPath: string,
	targetPath: string,
	label: string,
): Promise<void> {
	const anchor = resolve(anchorPath);
	const target = resolve(targetPath);
	const relativeTarget = relative(anchor, target);
	if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) {
		throw new Error(`${label} must remain below its trusted directory anchor`);
	}
	const segments = relativeTarget ? relativeTarget.split(sep) : [];
	await withRegularDirectoryNoFollow(anchor, `${label} anchor`, async (anchorDescriptorPath) => {
		const handles: Array<Awaited<ReturnType<typeof open>>> = [];
		let descriptorPath = anchorDescriptorPath;
		let absolutePath = anchor;
		try {
			for (const segment of segments) {
				const descriptorChild = join(descriptorPath, segment);
				const absoluteChild = join(absolutePath, segment);
				try {
					await mkdir(descriptorChild, { mode: 0o700 });
				} catch (error) {
					if (errorCode(error) !== "EEXIST") throw error;
				}
				await handles.at(-1)?.sync();

				let handle: Awaited<ReturnType<typeof open>>;
				try {
					handle = await open(descriptorChild, noFollowDirectoryFlags(label));
				} catch (error) {
					if (errorCode(error) === "ELOOP" || errorCode(error) === "ENOTDIR") {
						throw new Error(`${label} must be a regular directory tree without symbolic links`, {
							cause: error,
						});
					}
					throw error;
				}
				handles.push(handle);
				const descriptorStatus = await handle.stat();
				const pathStatus = await lstat(absoluteChild);
				if (
					!descriptorStatus.isDirectory() ||
					!pathStatus.isDirectory() ||
					pathStatus.isSymbolicLink() ||
					!sameIdentity(descriptorStatus, pathStatus) ||
					(await realpath(absoluteChild)) !== absoluteChild
				) {
					throw new Error(`${label} changed during no-follow directory creation`);
				}
				await handle.chmod(0o700);
				await handle.sync();
				const finalDescriptorStatus = await handle.stat();
				const finalPathStatus = await lstat(absoluteChild);
				if (
					!finalDescriptorStatus.isDirectory() ||
					!finalPathStatus.isDirectory() ||
					finalPathStatus.isSymbolicLink() ||
					!sameIdentity(descriptorStatus, finalDescriptorStatus) ||
					!sameIdentity(descriptorStatus, finalPathStatus) ||
					(await realpath(absoluteChild)) !== absoluteChild
				) {
					throw new Error(`${label} changed while directory permissions were fixed`);
				}
				descriptorPath = descriptorDirectoryPath(handle, label);
				absolutePath = absoluteChild;
			}
		} finally {
			for (const handle of handles.reverse()) await handle.close();
		}
	});
}

/**
 * Create and permission a private directory tree below an opened, verified anchor.
 * Without an explicit anchor, the target is secured below its nearest existing,
 * verified ancestor.
 */
export async function ensurePrivateDirectoryNoFollow(path: string, label: string, trustedRoot?: string): Promise<void> {
	const target = resolve(path);
	if (trustedRoot !== undefined) {
		await ensureDirectoryDescendantsNoFollow(trustedRoot, target, label);
		return;
	}
	await ensureDirectoryDescendantsNoFollow(await nearestExistingDirectory(target, label), target, label);
}

/** Read a canonical directory without following a symlink introduced below its trusted root. */
export async function readRegularDirectoryNoFollow(path: string, label: string): Promise<Dirent[]> {
	return withRegularDirectoryNoFollow(path, label, (descriptorPath) =>
		readdir(descriptorPath, { withFileTypes: true }),
	);
}

/** Atomically open and read one unchanged regular file without following symlinks. */
export async function readRegularFileNoFollow(path: string, label: string, maximumBytes?: number): Promise<Buffer> {
	return withRegularFileNoFollow(path, label, async (handle, status) => {
		if (maximumBytes === undefined) return handle.readFile();
		if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
			throw new Error(`${label} byte limit must be a non-negative safe integer`);
		}
		if (status.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
		const chunks: Buffer[] = [];
		let totalBytes = 0;
		const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, maximumBytes + 1));
		while (true) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
			if (totalBytes > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
			chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
		}
		return Buffer.concat(chunks, totalBytes);
	});
}

/** Copy one unchanged regular source through no-follow file handles into a new destination. */
export async function copyRegularFileNoFollow(source: string, destination: string, label: string): Promise<void> {
	await withRegularFileNoFollow(source, label, async (sourceHandle) => {
		const destinationHandle = await open(destination, "wx", 0o600);
		try {
			const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
			while (true) {
				const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.byteLength, null);
				if (bytesRead === 0) break;
				let offset = 0;
				while (offset < bytesRead) {
					const { bytesWritten } = await destinationHandle.write(buffer, offset, bytesRead - offset, null);
					if (bytesWritten === 0) throw new Error(`Could not copy ${label}`);
					offset += bytesWritten;
				}
			}
		} finally {
			await destinationHandle.close();
		}
	});
}

/** Atomically replace one regular file through an opened parent directory without following symlinks. */
export async function atomicWriteRegularFileNoFollow(path: string, content: string, label: string): Promise<void> {
	const absolutePath = resolve(path);
	const fileName = basename(absolutePath);
	if (!fileName || fileName === "." || fileName === "..") throw new Error(`${label} must name a file`);
	await withRegularDirectoryNoFollow(dirname(absolutePath), `${label} parent`, async (descriptorPath) => {
		const descriptorTarget = join(descriptorPath, fileName);
		try {
			const existing = await lstat(descriptorTarget);
			if (!existing.isFile() || existing.isSymbolicLink()) {
				throw new Error(`${label} must be a regular file without symbolic links`);
			}
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		await atomicWriteFile(descriptorTarget, content);
		const descriptorStatus = await lstat(descriptorTarget);
		const pathStatus = await lstat(absolutePath);
		if (
			!descriptorStatus.isFile() ||
			descriptorStatus.isSymbolicLink() ||
			!pathStatus.isFile() ||
			pathStatus.isSymbolicLink() ||
			!sameIdentity(descriptorStatus, pathStatus) ||
			(await realpath(absolutePath)) !== absolutePath
		) {
			throw new Error(`${label} changed while it was written`);
		}
	});
}

/** Durably remove one regular file through an opened parent directory without following symlinks. */
export async function durableUnlinkRegularFileNoFollow(path: string, label: string): Promise<boolean> {
	const absolutePath = resolve(path);
	const fileName = basename(absolutePath);
	if (!fileName || fileName === "." || fileName === "..") throw new Error(`${label} must name a file`);
	return withRegularDirectoryNoFollow(dirname(absolutePath), `${label} parent`, async (descriptorPath) => {
		const descriptorTarget = join(descriptorPath, fileName);
		let existing: Stats;
		try {
			existing = await lstat(descriptorTarget);
		} catch (error) {
			if (errorCode(error) === "ENOENT") return false;
			throw error;
		}
		if (!existing.isFile() || existing.isSymbolicLink()) {
			throw new Error(`${label} must be a regular file without symbolic links`);
		}
		return durableUnlink(descriptorTarget);
	});
}

/** Durably append text through an opened parent directory and an O_NOFOLLOW file handle. */
export async function appendRegularFileNoFollow(path: string, content: string, label: string): Promise<void> {
	const absolutePath = resolve(path);
	const fileName = basename(absolutePath);
	if (!fileName || fileName === "." || fileName === "..") throw new Error(`${label} must name a file`);
	await withRegularDirectoryNoFollow(dirname(absolutePath), `${label} parent`, async (descriptorPath) => {
		const descriptorTarget = join(descriptorPath, fileName);
		const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollowFlags(label);
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(descriptorTarget, flags, 0o600);
		} catch (error) {
			if (errorCode(error) === "ELOOP") {
				throw new Error(`${label} must be a regular file without symbolic links`, { cause: error });
			}
			throw error;
		}
		try {
			const status = await handle.stat();
			if (!status.isFile()) throw new Error(`${label} must be a regular file`);
			await handle.writeFile(content, "utf8");
			await handle.sync();
			const finalStatus = await lstat(descriptorTarget);
			if (!finalStatus.isFile() || finalStatus.isSymbolicLink() || !sameIdentity(status, finalStatus)) {
				throw new Error(`${label} changed while it was appended`);
			}
		} finally {
			await handle.close();
		}
	});
}
