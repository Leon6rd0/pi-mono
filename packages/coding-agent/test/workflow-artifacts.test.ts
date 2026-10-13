import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { TextDecoder } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createTextArchiveWriter,
	inspectTextArchive,
	MAX_TEXT_ARCHIVE_BYTES,
	MAX_WORKFLOW_ARCHIVE_BYTES,
	normalizeTextArchives,
} from "../examples/extensions/workflow/artifacts.ts";
import { WorkflowManager } from "../examples/extensions/workflow/manager.ts";
import { emptyUsage } from "../examples/extensions/workflow/types.ts";

const directories: string[] = [];
const spills: string[] = [];
const managers: WorkflowManager[] = [];
function setup() {
	const directory = fs.mkdtempSync(join(tmpdir(), "pi-archive-test-"));
	directories.push(directory);
	const id = `workflow-${randomUUID()}`;
	return { directory, id, write: createTextArchiveWriter(directory, id) };
}
function spill(text: string | Buffer) {
	const path = join(tmpdir(), `pi-codemode-${randomBytes(8).toString("hex")}.txt`);
	fs.writeFileSync(path, text, { flag: "wx", mode: 0o600 });
	spills.push(path);
	return path;
}
afterEach(async () => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	for (const path of spills.splice(0)) fs.rmSync(path, { force: true });
	for (const path of directories.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

describe("bounded Workflow text archives", () => {
	it.each([false, true])("retains a bounded valid UTF-8 prefix including BOM (spill=%s)", (fromSpill) => {
		const { directory, id, write } = setup();
		const text = `\ufeffx${"🙂汉é".repeat(50000)}TAIL`;
		const path = fromSpill ? spill(text) : undefined;
		const read = vi.spyOn(fs, "readSync");
		syncBuiltinESMExports();
		const archive = write(
			"script",
			path ? { spillPath: path } : { text, format: "script-content", sourcePartial: false },
		);
		expect(archive).toMatchObject({
			state: "saved",
			sourceBytes: Buffer.byteLength(text),
			sourcePartial: false,
			quotaClipped: true,
		});
		if (path) {
			expect(read).toHaveBeenCalled();
			const calls: unknown[][] = read.mock.calls;
			for (const call of calls) expect(call[3]).toBeLessThanOrEqual(MAX_TEXT_ARCHIVE_BYTES);
		} else expect(read).not.toHaveBeenCalled();
		const reference = inspectTextArchive(directory, id, "script", archive);
		expect(reference.available).toBe(true);
		const data = fs.readFileSync(reference.path!);
		expect(data.length).toBe(MAX_TEXT_ARCHIVE_BYTES - 2); // Cap falls two bytes into the next three-byte character.
		const decoded = new TextDecoder("utf8", { fatal: true, ignoreBOM: true }).decode(data);
		expect(text.startsWith(decoded)).toBe(true);
		expect(decoded.startsWith("\ufeff")).toBe(true);
		expect(decoded).not.toContain("�");
		if (process.platform !== "win32") expect(fs.statSync(reference.path!).mode & 0o777).toBe(0o600);
		if (path) expect(fs.readFileSync(path, "utf8")).toBe(text); // Source belongs to Codemode.
	});

	it.each([false, true])("does not clip a whole-code-point source exactly at the byte cap (spill=%s)", (fromSpill) => {
		const { directory, id, write } = setup();
		const text = "🙂".repeat(MAX_TEXT_ARCHIVE_BYTES / 4);
		const archive = write(
			"script",
			fromSpill ? { spillPath: spill(text) } : { text, format: "script-content", sourcePartial: false },
		);
		expect(archive).toMatchObject({
			state: "saved",
			retainedBytes: MAX_TEXT_ARCHIVE_BYTES,
			sourceBytes: MAX_TEXT_ARCHIVE_BYTES,
			sourcePartial: false,
			quotaClipped: false,
		});
		expect(fs.readFileSync(inspectTextArchive(directory, id, "script", archive).path!, "utf8")).toBe(text);
	});

	it("does not split a code point to fill the final byte of shared capacity", () => {
		const { directory, write } = setup();
		for (let i = 1; i <= 8; i++) {
			expect(
				write(`agent-${i}`, {
					text: "x".repeat(MAX_TEXT_ARCHIVE_BYTES - (i === 8 ? 1 : 0)),
					format: "child-text",
					sourcePartial: false,
				}).state,
			).toBe("saved");
		}
		expect(write("agent-9", { text: "🙂", format: "child-text", sourcePartial: false })).toEqual({
			state: "unavailable",
			reason: "quota",
		});
		expect(fs.readdirSync(directory)).toHaveLength(8); // No empty or malformed UTF-8 file.
		expect(write("script", { text: "x", format: "script-content", sourcePartial: false })).toMatchObject({
			state: "saved",
			retainedBytes: 1,
			sourceBytes: 1,
			quotaClipped: false,
		});
		expect(fs.readdirSync(directory).reduce((sum, name) => sum + fs.statSync(join(directory, name)).size, 0)).toBe(
			MAX_WORKFLOW_ARCHIVE_BYTES,
		);
	});

	it("separates an upstream partial source from local quota clipping", () => {
		const { write } = setup();
		expect(write("agent-1", { text: "available prefix", format: "child-text", sourcePartial: true })).toMatchObject({
			state: "saved",
			sourcePartial: true,
			quotaClipped: false,
			retainedBytes: 16,
			sourceBytes: 16,
		});
	});

	it("enforces the shared 2 MiB ceiling and the 33-file ceiling", () => {
		const { directory, write } = setup();
		const text = "x".repeat(MAX_TEXT_ARCHIVE_BYTES);
		for (let i = 1; i <= 8; i++)
			expect(write(`agent-${i}`, { text, format: "child-text", sourcePartial: false }).state).toBe("saved");
		expect(write("script", { text: "overflow", format: "script-content", sourcePartial: false })).toEqual({
			state: "unavailable",
			reason: "quota",
		});
		expect(fs.readdirSync(directory).reduce((sum, name) => sum + fs.statSync(join(directory, name)).size, 0)).toBe(
			MAX_WORKFLOW_ARCHIVE_BYTES,
		);
		const small = setup();
		for (let i = 1; i <= 32; i++)
			expect(small.write(`agent-${i}`, { text: "x", format: "child-text", sourcePartial: false }).state).toBe(
				"saved",
			);
		expect(small.write("script", { text: "x", format: "script-content", sourcePartial: false }).state).toBe("saved");
		expect(small.write("agent-1", { text: "x", format: "child-text", sourcePartial: false })).toEqual({
			state: "unavailable",
			reason: "quota",
		});
		expect(fs.readdirSync(small.directory)).toHaveLength(33);
	});

	it("charges failed partial writes and keeps their residue unavailable", () => {
		const { directory, id, write } = setup();
		const original = fs.writeFileSync;
		vi.spyOn(fs, "writeFileSync").mockImplementation((path, data, options) => {
			if (typeof path === "string" && path.startsWith(join(directory, id))) {
				original(path, "part", options);
				throw new Error("injected partial write failure");
			}
			return original(path, data, options);
		});
		syncBuiltinESMExports();
		for (let i = 1; i <= 8; i++) {
			const archive = write(`agent-${i}`, {
				text: "x".repeat(MAX_TEXT_ARCHIVE_BYTES),
				format: "child-text",
				sourcePartial: false,
			});
			expect(archive).toEqual({ state: "unavailable", reason: "write_failed" });
			expect(inspectTextArchive(directory, id, `agent-${i}`, archive).available).toBe(false);
		}
		expect(fs.readdirSync(directory)).toHaveLength(8);
		expect(fs.statSync(join(directory, `${id}.agent-1.txt`)).size).toBe(4);
		vi.restoreAllMocks();
		syncBuiltinESMExports();
		expect(write("script", { text: "no free retry", format: "script-content", sourcePartial: false })).toEqual({
			state: "unavailable",
			reason: "quota",
		});
	});

	it("rejects foreign paths, symlinks, directories and malformed source UTF-8", () => {
		const { directory, write } = setup();
		const outside = join(directory, "outside.txt");
		fs.writeFileSync(outside, "SECRET");
		const linked = spill("placeholder");
		fs.rmSync(linked);
		fs.symlinkSync(outside, linked);
		const read = vi.spyOn(fs, "readSync");
		syncBuiltinESMExports();
		for (const path of [outside, linked, directory])
			expect(write("script", { spillPath: path })).toEqual({ state: "unavailable", reason: "invalid_source" });
		expect(read).not.toHaveBeenCalled();
		expect(write("script", { spillPath: spill(Buffer.from([0xf0, 0x9f])) })).toEqual({
			state: "unavailable",
			reason: "invalid_source",
		});
		expect(fs.readFileSync(outside, "utf8")).toBe("SECRET");
	});

	it("rejects substituted non-regular opened sources and closes their fd", () => {
		const { write } = setup();
		const path = spill("text");
		const actual = fs.fstatSync;
		vi.spyOn(fs, "fstatSync").mockImplementation((fd) => {
			const stat = actual(fd);
			stat.isFile = () => false;
			return stat;
		});
		const opened = vi.spyOn(fs, "openSync");
		const closed = vi.spyOn(fs, "closeSync");
		syncBuiltinESMExports();
		expect(write("script", { spillPath: path })).toEqual({ state: "unavailable", reason: "invalid_source" });
		expect(opened).toHaveBeenCalledWith(
			path,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		expect(closed).toHaveBeenCalledWith(opened.mock.results[0].value);
	});

	it.each(["read", "fstat", "decode"] as const)(
		"closes the opened spill fd on %s failure without publishing a file",
		(failure) => {
			const { directory, write } = setup();
			const path = spill(failure === "decode" ? Buffer.from([0xf0, 0x9f]) : "text");
			if (failure === "read")
				vi.spyOn(fs, "readSync").mockImplementationOnce(() => {
					throw new Error("injected read failure");
				});
			if (failure === "fstat")
				vi.spyOn(fs, "fstatSync").mockImplementationOnce(() => {
					throw new Error("injected fstat failure");
				});
			const opened = vi.spyOn(fs, "openSync");
			const closed = vi.spyOn(fs, "closeSync");
			syncBuiltinESMExports();
			expect(write("script", { spillPath: path })).toEqual({ state: "unavailable", reason: "invalid_source" });
			expect(opened).toHaveBeenCalledTimes(1);
			expect(closed).toHaveBeenCalledTimes(1);
			expect(closed).toHaveBeenCalledWith(opened.mock.results[0].value);
			expect(fs.readdirSync(directory)).toEqual([]);
		},
	);

	it("does not overwrite destination links or accept a linked archive directory", () => {
		const { directory, id, write } = setup();
		const target = join(directory, "untouched");
		fs.writeFileSync(target, "keep");
		fs.symlinkSync(target, join(directory, `${id}.script.txt`));
		expect(write("script", { text: "replace", format: "script-content", sourcePartial: false })).toEqual({
			state: "unavailable",
			reason: "write_failed",
		});
		expect(fs.readFileSync(target, "utf8")).toBe("keep");
		const linked = join(directory, "linked-dir");
		fs.symlinkSync(directory, linked, "dir");
		expect(
			createTextArchiveWriter(linked, id)("agent-1", { text: "x", format: "child-text", sourcePartial: false }),
		).toEqual({ state: "unavailable", reason: "write_failed" });
		expect(write("../outside", { text: "x", format: "child-text", sourcePartial: false }).state).toBe("unavailable");
	});

	it.each(["missing", "size", "symlink"] as const)(
		"projects %s archives without mutating their historical descriptor",
		(damage) => {
			const { directory, id, write } = setup();
			const archive = write("script", { text: "retained", format: "script-content", sourcePartial: false });
			const before = structuredClone(archive);
			const path = inspectTextArchive(directory, id, "script", archive).path!;
			if (damage === "size") fs.writeFileSync(path, "x");
			else {
				fs.rmSync(path);
				if (damage === "symlink") fs.symlinkSync(join(directory, "absent"), path);
			}
			expect(inspectTextArchive(directory, id, "script", archive)).toMatchObject({
				state: "saved",
				available: false,
				issue: "missing_or_changed",
			});
			expect(inspectTextArchive(directory, id, "script", archive).path).toBeUndefined();
			expect(archive).toEqual(before);
		},
	);

	it("salvages malformed descriptors instead of hiding metadata or importing a restored path", () => {
		const { directory, id } = setup();
		const options = { storageRoot: directory, sessionId: "archive-restore", onReady: vi.fn() };
		const first = new WorkflowManager(options);
		managers.push(first);
		const record = {
			id,
			label: "retained metadata",
			cwd: directory,
			provider: "faux",
			model: "faux",
			phase: "Done",
			status: "awaiting_result",
			outcome: "completed",
			usage: emptyUsage(),
			createdAt: 1,
			updatedAt: 2,
			result: "preview",
			resultArchive: { state: "saved", path: "/should/not/be/imported", retainedBytes: 9 },
			agents: [
				{
					id: `${id}/agent-1`,
					role: "scout",
					label: "one",
					phase: "Done",
					status: "completed",
					outputArchive: { state: "invalid" },
				},
			],
		};
		fs.writeFileSync(first.recordPath(id), JSON.stringify(record));
		const restored = new WorkflowManager(options);
		managers.push(restored);
		const stat = vi.spyOn(fs, "lstatSync");
		syncBuiltinESMExports();
		expect(restored.get(id)).toMatchObject({
			result: "preview",
			resultArchive: { state: "unavailable", reason: "invalid_metadata" },
		});
		expect(restored.list()).toHaveLength(1);
		expect(stat).not.toHaveBeenCalled();
		expect(restored.archives(id).every((item) => !item.available && !item.path)).toBe(true);
		expect(stat).not.toHaveBeenCalled();
		expect(options.onReady).not.toHaveBeenCalled();
		expect(() => restored.resume(id)).toThrow("never restarted");
		expect(restored.result(id).workflow.resultRead).toBe(true);
		expect(restored.acknowledge(id, "processed missing archives").status).toBe("archived");
		const old = { ...record, resultArchive: undefined, agents: [] };
		fs.writeFileSync(first.recordPath(id), JSON.stringify(old));
		const legacy = new WorkflowManager(options);
		managers.push(legacy);
		expect(legacy.get(id).resultArchive).toBeUndefined();
		expect(legacy.archives(id)).toEqual([]);
		const archiveDirectory = dirname(first.recordPath(id));
		const saved = createTextArchiveWriter(archiveDirectory, id)("script", {
			text: "retained",
			format: "script-content",
			sourcePartial: false,
		});
		const savedPath = inspectTextArchive(archiveDirectory, id, "script", saved).path!;
		fs.writeFileSync(
			first.recordPath(id),
			JSON.stringify({ ...old, agents: [{ ...record.agents[0], id: `${id}/script`, outputArchive: saved }] }),
		);
		const forgedSlot = new WorkflowManager(options);
		managers.push(forgedSlot);
		stat.mockClear();
		expect(forgedSlot.archives(id)).toMatchObject([{ state: "saved", available: false, issue: "invalid_reference" }]);
		expect(stat).not.toHaveBeenCalled(); // A forged agent cannot even project the Workflow's script slot.
		fs.rmSync(savedPath);
		fs.writeFileSync(first.recordPath(id), JSON.stringify({ ...old, resultArchive: saved }));
		const missing = new WorkflowManager(options);
		managers.push(missing);
		stat.mockClear();
		expect(missing.get(id).result).toBe("preview");
		expect(missing.list()).toHaveLength(1);
		expect(stat).not.toHaveBeenCalled();
		expect(missing.archives(id)).toMatchObject([{ state: "saved", available: false, issue: "missing_or_changed" }]);
		expect(options.onReady).not.toHaveBeenCalled();
		const invalid = {
			resultArchive: {
				state: "saved",
				format: "child-text",
				sourceBytes: 1,
				retainedBytes: 2,
				quotaClipped: false,
				sourcePartial: false,
			},
		};
		normalizeTextArchives(invalid);
		expect(invalid.resultArchive).toEqual({ state: "unavailable", reason: "invalid_metadata" });
		expect(dirname(first.recordPath(id))).not.toBe(directory);
	});
});
