import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RecordedEvent } from "../recorder/schema.ts";
import type { EvidenceCorpus, EvidenceFragment, EvidenceSource } from "../reflect/evidence.ts";
import { atomicWriteFile } from "../storage.ts";

const CLIP_NOTE = "…[clipped; full content in the matching sessions-raw JSON file]";
const EVENT_TEXT_CLIP = 4_000;
const THINKING_CLIP = 600;
const TOOL_ARGUMENT_CLIP = 600;

export interface MaterializedCorpusFile {
	/** Path relative to the run directory, e.g. corpus/sessions/<id>.md */
	path: string;
	bytes: number;
	description: string;
}

export interface MaterializedCorpus {
	/** Absolute path of the corpus directory. */
	directory: string;
	files: MaterializedCorpusFile[];
	/** Prompt-ready index: one line per file plus reading guidance. */
	indexText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}${CLIP_NOTE}`;
}

function compactJson(value: unknown, maxChars: number): string {
	try {
		return clip(JSON.stringify(value) ?? "null", maxChars);
	} catch {
		return "[unserializable]";
	}
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderContentBlocks(content: unknown): string[] {
	if (typeof content === "string") return [clip(content, EVENT_TEXT_CLIP)];
	if (!Array.isArray(content)) return [compactJson(content, EVENT_TEXT_CLIP)];
	const lines: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) {
			lines.push(compactJson(block, TOOL_ARGUMENT_CLIP));
			continue;
		}
		switch (block.type) {
			case "text":
				lines.push(clip(typeof block.text === "string" ? block.text : "", EVENT_TEXT_CLIP));
				break;
			case "thinking":
				lines.push(`(thinking) ${clip(typeof block.thinking === "string" ? block.thinking : "", THINKING_CLIP)}`);
				break;
			case "toolCall": {
				const name = isRecord(block.toolCall) ? block.toolCall.name : (block.name ?? "unknown");
				const args = isRecord(block.toolCall) ? block.toolCall.arguments : block.arguments;
				lines.push(`(tool call) ${String(name)} ${compactJson(args, TOOL_ARGUMENT_CLIP)}`);
				break;
			}
			default:
				lines.push(compactJson(block, TOOL_ARGUMENT_CLIP));
		}
	}
	return lines;
}

function renderToolResult(result: unknown): string {
	if (typeof result === "string") return clip(result, EVENT_TEXT_CLIP);
	if (isRecord(result) && Array.isArray(result.content)) {
		const texts = result.content.flatMap((item) =>
			isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : [],
		);
		if (texts.length > 0) return clip(texts.join("\n"), EVENT_TEXT_CLIP);
	}
	return compactJson(result, EVENT_TEXT_CLIP);
}

function renderEvent(event: RecordedEvent & Record<string, unknown>): string[] {
	const head = `### seq ${event.sequence} — ${event.type} (${event.timestamp})`;
	switch (event.type) {
		case "session_start":
			return [`${head}\nreason=${event.reason} cwd=${event.cwd}`];
		case "session_end":
			return [`${head}\nreason=${event.reason}`];
		case "before_agent_start": {
			const prompt = typeof event.prompt === "string" ? event.prompt : compactJson(event.prompt, EVENT_TEXT_CLIP);
			const systemPromptBytes =
				typeof event.systemPrompt === "string" ? Buffer.byteLength(event.systemPrompt, "utf8") : undefined;
			return [
				`${head}\nprompt:\n${clip(prompt, EVENT_TEXT_CLIP)}`,
				systemPromptBytes === undefined
					? "(system prompt unavailable inline; see raw JSON)"
					: `(system prompt: ${formatBytes(systemPromptBytes)}, see raw JSON for full text)`,
			];
		}
		case "message": {
			const message = event.message;
			const content = isRecord(message) ? message.content : message;
			return [`${head} role=${event.role}`, ...renderContentBlocks(content)];
		}
		case "usage":
			return [`${head}\n${compactJson({ provider: event.provider, model: event.model, usage: event.usage }, 800)}`];
		case "tool": {
			const status = event.isError ? "ERROR" : "ok";
			return [
				`${head} ${event.toolName} [${status}, ${event.durationMs}ms]`,
				`input: ${compactJson(event.input, TOOL_ARGUMENT_CLIP)}`,
				`result:\n${renderToolResult(event.result)}`,
			];
		}
		case "git_diff": {
			const diff = typeof event.diff === "string" ? event.diff : compactJson(event.diff, EVENT_TEXT_CLIP);
			return [`${head} clean=${event.clean}`, clip(diff, EVENT_TEXT_CLIP)];
		}
		case "explicit_feedback": {
			const text = typeof event.text === "string" ? event.text : compactJson(event.text, EVENT_TEXT_CLIP);
			return [`${head} source=${event.source} inboxFile=${event.inboxFile}`, text];
		}
		case "compaction": {
			const summary =
				typeof event.summary === "string" ? event.summary : compactJson(event.summary, EVENT_TEXT_CLIP);
			return [
				`${head} **COMPACTION** reason=${event.reason} willRetry=${event.willRetry} tokensBefore=${event.tokensBefore}`,
				`summary:\n${summary}`,
			];
		}
		default:
			return [`${head}\n${compactJson(event, EVENT_TEXT_CLIP)}`];
	}
}

function renderSessionMarkdown(sessionId: string, fragments: readonly EvidenceFragment[]): string {
	const parts: string[] = [`# Session ${sessionId}`, ""];
	for (const fragment of fragments) {
		if (fragment.heading.startsWith("## Session digest ")) {
			parts.push("## Digest", "```json", JSON.stringify(fragment.value, undefined, "\t"), "```", "");
			continue;
		}
		const value = fragment.value;
		if (isRecord(value) && typeof value.type === "string" && typeof value.sequence === "number") {
			parts.push(...renderEvent(value as RecordedEvent & Record<string, unknown>), "");
			continue;
		}
		parts.push(fragment.heading, compactJson(value, EVENT_TEXT_CLIP), "");
	}
	return `${parts.join("\n").trimEnd()}\n`;
}

function renderPlainSource(fragments: readonly EvidenceFragment[]): string {
	const sections = fragments.map(
		(fragment) =>
			`${fragment.heading}\n${
				typeof fragment.value === "string" ? fragment.value : JSON.stringify(fragment.value, undefined, "\t")
			}`,
	);
	return `${sections.join("\n\n").trimEnd()}\n`;
}

// Inbox is deliberately absent: explicit user inputs are small, carry a
// must-classify obligation, and therefore stay inline in the prompt index.
const PLAIN_SOURCE_DESCRIPTIONS: Record<Exclude<EvidenceSource, "sessions" | "inbox">, string> = {
	bundle: "stable bundle manifest and bundle files",
	history: "registry history and inbox lifecycle entries (newest first)",
};

/**
 * Write the evidence corpus into <runDirectory>/corpus as an on-demand file tree and
 * return a compact prompt index. Sessions get a rendered markdown transcript (dense,
 * readable) plus a pretty-printed raw JSON twin for exact quoting — no pathological
 * single-line files.
 */
export async function materializeEvidenceCorpus(
	corpus: EvidenceCorpus,
	runDirectory: string,
): Promise<MaterializedCorpus> {
	const directory = join(runDirectory, "corpus");
	await mkdir(join(directory, "sessions"), { recursive: true });
	await mkdir(join(directory, "sessions-raw"), { recursive: true });

	const files: MaterializedCorpusFile[] = [];
	const write = async (relativePath: string, content: string, description: string): Promise<void> => {
		await atomicWriteFile(join(runDirectory, relativePath), content);
		files.push({ path: relativePath, bytes: Buffer.byteLength(content, "utf8"), description });
	};

	for (const source of ["bundle", "history"] as const) {
		const fragments = corpus.fragments.filter((fragment) => fragment.source === source);
		if (fragments.length === 0) continue;
		await write(`corpus/${source}.md`, renderPlainSource(fragments), PLAIN_SOURCE_DESCRIPTIONS[source]);
	}

	const sessionFragments = new Map<string, EvidenceFragment[]>();
	for (const fragment of corpus.fragments) {
		if (fragment.source !== "sessions" || !fragment.sessionId) continue;
		const existing = sessionFragments.get(fragment.sessionId);
		if (existing) existing.push(fragment);
		else sessionFragments.set(fragment.sessionId, [fragment]);
	}
	for (const [sessionId, fragments] of sessionFragments) {
		await write(
			`corpus/sessions/${sessionId}.md`,
			renderSessionMarkdown(sessionId, fragments),
			"rendered session transcript (messages, tools, usage, compaction boundaries)",
		);
		const rawEvents = fragments
			.filter((fragment) => !fragment.heading.startsWith("## Session digest "))
			.map((fragment) => fragment.value);
		await write(
			`corpus/sessions-raw/${sessionId}.json`,
			`${JSON.stringify(rawEvents, undefined, "\t")}\n`,
			"full recorded events for exact quoting (pretty-printed JSON)",
		);
	}

	const indexLines = files.map((file) => `- ${file.path} (${formatBytes(file.bytes)}) — ${file.description}`);
	const inboxFragments = corpus.fragments.filter((fragment) => fragment.source === "inbox");
	const indexText = [
		`The evidence corpus is materialized as files under: ${directory}`,
		"Read them on demand with read/grep/find/ls instead of assuming their content.",
		"Prefer the rendered corpus/sessions/*.md transcripts; open corpus/sessions-raw/*.json only to verify exact quotes or payload details.",
		"",
		...indexLines,
		"",
		// Explicit user inputs stay inline: every entry below must be classified.
		...(inboxFragments.length > 0
			? [
					"Open explicit user inbox inputs (classify every file below in inboxDecisions):",
					renderPlainSource(inboxFragments),
				]
			: ["There are no open explicit user inbox inputs."]),
	].join("\n");

	// Persist the index so later phases (evidence resumption) can rebuild the
	// prompt block without recollecting the corpus.
	await atomicWriteFile(join(directory, "INDEX.md"), `${indexText}\n`);

	return { directory, files, indexText };
}

/** Rehydrate a materialized corpus from its persisted index, when one exists. */
export async function readMaterializedCorpus(runDirectory: string): Promise<MaterializedCorpus | undefined> {
	const directory = join(runDirectory, "corpus");
	try {
		const indexText = (await readFile(join(directory, "INDEX.md"), "utf8")).trimEnd();
		return { directory, files: [], indexText };
	} catch (error) {
		if ((error as { code?: string }).code === "ENOENT") return undefined;
		throw error;
	}
}
