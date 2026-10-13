import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowManager } from "../examples/extensions/workflow/manager.ts";
import { emptyUsage, type WorkflowRecord } from "../examples/extensions/workflow/types.ts";

const directories: string[] = [];
const managers: WorkflowManager[] = [];

function setup() {
	const storageRoot = mkdtempSync(join(tmpdir(), "pi-workflow-commit-"));
	directories.push(storageRoot);
	const options = { storageRoot, sessionId: "record-commit-fixture" };
	const reload = () => {
		const manager = new WorkflowManager(options);
		managers.push(manager);
		return manager;
	};
	const id = `workflow-${randomUUID()}`;
	const path = reload().recordPath(id);
	const record: WorkflowRecord = {
		id,
		label: "ready local fixture",
		cwd: storageRoot,
		provider: "faux",
		model: "faux",
		status: "awaiting_result",
		outcome: "completed",
		phase: "Done",
		agents: [],
		usage: { ...emptyUsage(), output: 12, totalTokens: 12 },
		createdAt: 1,
		updatedAt: 2,
		result: "retained findings",
	};
	writeFileSync(path, JSON.stringify(record));
	const manager = reload();
	expect(manager.get(id)).toStrictEqual(record);
	return { manager, id, path, reload };
}

/** Real filesystem failures, scoped to an owned fixture; no permission-dependent chmod mock. */
function withStorageFailure(path: string, kind: "write" | "rename", operation: () => void) {
	const target = kind === "write" ? dirname(path) : path;
	const backup = `${target}.unavailable`;
	renameSync(target, backup);
	try {
		if (kind === "rename") mkdirSync(target);
		operation();
	} finally {
		if (kind === "rename") rmSync(target, { recursive: true, force: true });
		renameSync(backup, target);
	}
}

afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe.each(["write", "rename"] as const)("Workflow record %s failure", (kind) => {
	it.each([true, false])("does not consume a result or its one-time usage (reportUsage=%s)", (reportUsage) => {
		const { manager, id, path, reload } = setup();
		const before = manager.get(id);
		const bytes = readFileSync(path, "utf8");
		withStorageFailure(path, kind, () => {
			expect(() => manager.result(id, reportUsage)).toThrow();
			expect(manager.get(id)).toStrictEqual(before);
			expect(() => manager.acknowledge(id, "must not archive an unread result")).toThrow("Read the ready result");
		});
		expect(readFileSync(path, "utf8")).toBe(bytes);
		expect(manager.result(id, reportUsage).usage?.totalTokens).toBe(reportUsage ? 12 : undefined);
		const restored = reload();
		expect(restored.get(id).resultRead).toBe(true);
		expect(restored.result(id).usage?.totalTokens).toBe(reportUsage ? undefined : 12);
		expect(restored.result(id).usage).toBeUndefined();
	});

	it("keeps failed acknowledgement active and permits a durable retry without consuming command-only usage", () => {
		const { manager, id, path, reload } = setup();
		manager.result(id, false);
		const before = manager.get(id);
		const bytes = readFileSync(path, "utf8");
		withStorageFailure(path, kind, () => {
			expect(() => manager.acknowledge(id, "processing complete")).toThrow();
			expect(manager.get(id)).toStrictEqual(before);
			expect(manager.list()).toHaveLength(1);
		});
		expect(readFileSync(path, "utf8")).toBe(bytes);
		expect(manager.acknowledge(id, "processing complete")).toMatchObject({
			status: "archived",
			acknowledgement: "processing complete",
			acknowledgedAt: expect.any(Number),
		});
		expect(manager.list()).toEqual([]);
		const restored = reload();
		expect(restored.get(id)).toMatchObject({ status: "archived", resultRead: true });
		expect(restored.result(id).usage?.totalTokens).toBe(12);
		expect(restored.result(id).usage).toBeUndefined();
	});
});
