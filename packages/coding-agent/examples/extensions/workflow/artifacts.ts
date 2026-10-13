import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

export const MAX_TEXT_ARCHIVE_BYTES = 256 * 1024;
export const MAX_WORKFLOW_ARCHIVE_BYTES = 2 * 1024 * 1024;
export const MAX_WORKFLOW_ARCHIVES = 33;

export const textArchiveSchema = Type.Union([
	Type.Object(
		{
			state: Type.Literal("saved"),
			format: StringEnum(["child-text", "script-content", "codemode-spill"] as const),
			retainedBytes: Type.Integer({ minimum: 0, maximum: MAX_TEXT_ARCHIVE_BYTES }),
			// Size of supplied text/spill, NOT the size of anything lost upstream.
			sourceBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
			sourcePartial: Type.Boolean(),
			quotaClipped: Type.Boolean(),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			state: Type.Literal("unavailable"),
			reason: StringEnum([
				"quota",
				"write_failed",
				"invalid_source",
				"source_unavailable",
				"invalid_metadata",
				"invalid_reference",
			] as const),
		},
		{ additionalProperties: false },
	),
]);
export type TextArchive = Static<typeof textArchiveSchema>;
export type TextArchiveView = TextArchive & { available: boolean; path?: string; issue?: string };
export type TextArchiveSource =
	| { text: string; format: "child-text" | "script-content"; sourcePartial: boolean }
	// Only the current trusted runner may supply this; never restored metadata or script text.
	| { spillPath: string };

function archivePath(directory: string, id: string, slot: string): string | undefined {
	if (!/^workflow-[a-f0-9-]{36}$/.test(id) || !/^(script|agent-(?:[1-9]|[12][0-9]|3[0-2]))$/.test(slot))
		return undefined;
	return join(directory, `${id}.${slot}.txt`);
}
function validArchive(value: unknown): value is TextArchive {
	return (
		Check(textArchiveSchema, value) &&
		(value.state !== "saved" ||
			(value.retainedBytes <= value.sourceBytes && value.quotaClipped === value.retainedBytes < value.sourceBytes))
	);
}
function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Salvage otherwise valid metadata without granting any path authority to new fields. */
export function normalizeTextArchives(record: unknown): void {
	if (!isObject(record)) return;
	const owners: Array<[Record<string, unknown>, string]> = [[record, "resultArchive"]];
	if (Array.isArray(record.agents)) {
		for (const agent of record.agents.slice(0, 32)) if (isObject(agent)) owners.push([agent, "outputArchive"]);
	}
	for (const [owner, key] of owners) {
		if (Object.hasOwn(owner, key) && owner[key] !== undefined && !validArchive(owner[key]))
			owner[key] = { state: "unavailable", reason: "invalid_metadata" };
	}
}

/** One live run's bounded writer; no restore, retries, background work or new lifecycle owner. */
export function createTextArchiveWriter(directory: string, id: string) {
	let bytes = 0;
	let files = 0;
	return (slot: string, source: TextArchiveSource): TextArchive => {
		const path = archivePath(directory, id, slot);
		if (!path) return { state: "unavailable", reason: "invalid_reference" };
		const capacity = Math.min(MAX_TEXT_ARCHIVE_BYTES, MAX_WORKFLOW_ARCHIVE_BYTES - bytes);
		if (files >= MAX_WORKFLOW_ARCHIVES || capacity <= 0) return { state: "unavailable", reason: "quota" };
		let data: Buffer;
		let sourceBytes: number;
		let format: "child-text" | "script-content" | "codemode-spill";
		let sourcePartial: boolean;
		try {
			if ("text" in source) {
				sourceBytes = Buffer.byteLength(source.text, "utf8");
				const buffer = Buffer.alloc(Math.min(sourceBytes, capacity));
				// Buffer.write stops before an incomplete UTF-8 code point, without encoding the whole string.
				data = buffer.subarray(0, buffer.write(source.text, 0, buffer.length, "utf8"));
				format = source.format;
				sourcePartial = source.sourcePartial;
			} else {
				const path = source.spillPath;
				if (
					!isAbsolute(path) ||
					dirname(path) !== resolve(tmpdir()) ||
					!/^pi-codemode-[a-f0-9]{16}\.txt$/.test(basename(path))
				)
					return { state: "unavailable", reason: "invalid_source" };
				if (!lstatSync(path).isFile()) return { state: "unavailable", reason: "invalid_source" };
				// NONBLOCK prevents a substituted FIFO from hanging the host before fstat rejects it.
				const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
				try {
					const before = fstatSync(fd);
					if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0)
						return { state: "unavailable", reason: "invalid_source" };
					sourceBytes = before.size;
					const buffer = Buffer.alloc(Math.min(sourceBytes, capacity));
					let read = 0;
					while (read < buffer.length) {
						const count = readSync(fd, buffer, read, buffer.length - read, read);
						if (count === 0) throw new Error("Spill changed during import");
						read += count;
					}
					const after = fstatSync(fd);
					if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
						throw new Error("Spill changed during import");
					// In clipped input only, leave a trailing partial code point out of the retained prefix.
					const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer, {
						stream: read < sourceBytes,
					});
					data = Buffer.from(text, "utf8"); // At most capacity, never the unbounded source file.
				} finally {
					closeSync(fd);
				}
				format = "codemode-spill";
				sourcePartial = false; // Relative to formatted script text, not delegates' full outputs/transcript.
			}
		} catch {
			return { state: "unavailable", reason: "invalid_source" };
		}
		if (sourceBytes > 0 && data.length === 0) return { state: "unavailable", reason: "quota" };
		// Reserve before writing; failed/partial writes and unpublished files never release their quota.
		bytes += data.length;
		files++;
		try {
			if (!lstatSync(directory).isDirectory()) throw new Error("Archive directory is not a plain directory");
			writeFileSync(path, data, { flag: "wx", mode: 0o600 });
			return {
				state: "saved",
				format,
				retainedBytes: data.length,
				sourceBytes,
				sourcePartial,
				quotaClipped: data.length < sourceBytes,
			};
		} catch {
			return { state: "unavailable", reason: "write_failed" };
		}
	};
}

/** Explicit status/result view only. Persisted descriptors have no path or current availability claim. */
export function inspectTextArchive(directory: string, id: string, slot: string, archive: TextArchive): TextArchiveView {
	if (!validArchive(archive)) return { state: "unavailable", reason: "invalid_metadata", available: false };
	if (archive.state !== "saved") return { ...archive, available: false };
	const path = archivePath(directory, id, slot);
	if (!path) return { ...archive, available: false, issue: "invalid_reference" };
	try {
		if (!lstatSync(directory).isDirectory()) throw new Error("Invalid archive directory");
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.size !== archive.retainedBytes) throw new Error("Missing or changed archive");
		return { ...archive, available: true, path };
	} catch {
		return { ...archive, available: false, issue: "missing_or_changed" };
	}
}
