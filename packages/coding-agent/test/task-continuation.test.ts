import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CONTINUITY_LIMITS,
	TaskContinuation,
	taskDisplayState,
} from "../examples/extensions/task-monitor/continuation.ts";
import { TaskManager } from "../examples/extensions/task-monitor/manager.ts";

const roots: string[] = [];
const managers: TaskManager[] = [];
function setup() {
	const storageRoot = mkdtempSync(join(tmpdir(), "task-continuity-"));
	roots.push(storageRoot);
	const executions: Array<(value: { exitCode: number | null }) => void> = [];
	const manager = new TaskManager({
		storageRoot,
		sessionId: "continuity",
		operations: {
			exec: (_command, _cwd, options) =>
				new Promise((resolve, reject) => {
					executions.push(resolve);
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		},
	});
	managers.push(manager);
	const root = manager.createTask("Approved bounded engineering task");
	manager.updateTask(root.id, "running", {
		phase: "phase-1",
		summary: "checkpoint",
		nextAction: { key: "step-1", instruction: "Implement the assigned unit; no release" },
	});
	let now = 1000;
	const driver = new TaskContinuation(manager, () => now);
	return {
		manager,
		driver,
		root,
		storageRoot,
		executions,
		time: (value: number) => {
			now = value;
		},
	};
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
afterEach(async () => {
	await Promise.all(managers.splice(0).map((manager) => manager.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable task checkpoints and continuation", () => {
	it("persists summary/phase/next action, with explicit clearing and bounded validation", () => {
		const { manager, root } = setup();
		const saved = manager.updateTask(root.id, undefined, { summary: "saved update summary" });
		expect(saved).toMatchObject({ phase: "phase-1", summary: "saved update summary", nextAction: { key: "step-1" } });
		manager.updateTask(root.id, undefined, { blockedReason: "requires approval" });
		expect(manager.get(root.id).blockedReason).toBe("requires approval");
		expect(() => manager.updateTask(root.id, undefined, { summary: "x".repeat(1001) })).toThrow("oversized");
		expect(manager.get(root.id).summary).toBe("saved update summary");
		manager.updateTask(root.id, undefined, { nextAction: null, blockedReason: null });
		expect(manager.get(root.id).nextAction).toBeUndefined();
		expect(manager.get(root.id).blockedReason).toBeUndefined();
	});

	it("does not interpret a legacy running label or checkpoint as consent", () => {
		const { manager, driver, root } = setup();
		expect(driver.reserve([], "invented approval")).toBeUndefined();
		expect(driver.view([]).state).toBe("off");
		expect(taskDisplayState(manager.get(root.id), manager.list())).toBe("task:needs-continuation");
	});

	it("requires root, ready checkpoint, explicit bounded activation and matching branch receipt", () => {
		const { manager, driver, root } = setup();
		const child = manager.createTask("child", [], root.id);
		expect(() => driver.activate(child.id, "receipt", "user-command")).toThrow("root");
		expect(() => driver.activate(root.id, "receipt", "user-command", 17)).toThrow("1–16");
		driver.activate(root.id, "receipt", "user-command");
		expect(driver.reserve([], "other branch")).toBeUndefined();
		expect(driver.snapshot()).toMatchObject({ state: "paused", used: 0 });
	});

	it("reserves before dispatch and stops after repeated summaries without semantic progress", () => {
		const { manager, driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		expect(driver.reserve([], "receipt")).toContain("step-1");
		expect(JSON.parse(readFileSync(manager.continuityPath(), "utf8")).used).toBe(1);
		manager.updateTask(root.id, undefined, { summary: "another claim of progress" });
		expect(driver.reserve([], "receipt")).toBeDefined();
		manager.updateTask(root.id, undefined, { summary: "yet another claim of progress" });
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.snapshot()).toMatchObject({
			state: "paused",
			used: 2,
			reason: expect.stringContaining("No checkpoint"),
		});
	});

	it("real checkpoint changes do not reset the hard continuation allowance", () => {
		const { manager, driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command", 3);
		for (let i = 0; i < 3; i++) {
			manager.updateTask(root.id, undefined, { nextAction: { key: `s${i}`, instruction: "bounded step" } });
			expect(driver.reserve([], "receipt")).toBeDefined();
		}
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.snapshot()).toMatchObject({
			used: 3,
			state: "paused",
			reason: expect.stringContaining("count limit"),
		});
	});

	it("expiry and explicit pause never restart an executor", () => {
		const { driver, root, time, executions } = setup();
		driver.activate(root.id, "receipt", "user-command");
		time(1000 + CONTINUITY_LIMITS.lifetimeMs);
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.snapshot()?.reason).toContain("time limit");
		expect(executions).toEqual([]);
	});

	it("reload preserves checkpoints and counters but revokes the live continuation lease", () => {
		const { manager, driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		driver.reserve([], "receipt");
		const restored = new TaskContinuation(manager, () => 1001);
		expect(restored.snapshot()).toMatchObject({ state: "paused", used: 1, receipt: "receipt" });
		expect(restored.reserve([], "receipt")).toBeUndefined();
		expect(manager.get(root.id)).toMatchObject({ phase: "phase-1", summary: "checkpoint" });
	});

	it("links descendants, waits without polling, and advances only after result processing", async () => {
		const { manager, driver, root, storageRoot, executions } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const leaf = manager.createTask("verify", [], root.id);
		const job = manager.start({
			command: "verify",
			label: "verify",
			cwd: storageRoot,
			taskId: leaf.id,
			parentTaskId: root.id,
		});
		await tick();
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.view([])).toMatchObject({ state: "waiting", waitingOn: [job.id] });
		expect(driver.snapshot()?.used).toBe(0);
		expect(() => manager.updateTask(root.id, "completed")).toThrow("child");
		manager.updateTask(leaf.id, undefined, { summary: "Checkpoint recorded while detached job was running" });
		executions[0]({ exitCode: 0 });
		await tick();
		expect(manager.get(leaf.id).summary).toBe("Checkpoint recorded while detached job was running");
		expect(driver.view([]).state).toBe("awaiting_processing");
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.reserveEvent([job.id], "receipt")).toBe(true);
		expect(driver.reserveEvent([job.id], "receipt")).toBe(false);
		manager.acknowledge(job.id, "Read and verified output");
		expect(driver.reserve([], "receipt")).toBeDefined();
		manager.updateTask(root.id, "completed");
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.snapshot()?.state).toBe("completed");
	});

	it("a failed child keeps its outcome and blocks automatic next-step dispatch", async () => {
		const { manager, driver, root, storageRoot, executions } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const job = manager.start({ command: "verify", label: "verify", cwd: storageRoot, parentTaskId: root.id });
		await tick();
		executions[0]({ exitCode: 1 });
		await tick();
		expect(driver.reserveEvent([job.id], "receipt")).toBe(true);
		manager.acknowledge(job.id, "Failure retained, not retried");
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.snapshot()?.state).toBe("blocked");
		expect(manager.get(job.id).status).toBe("failed");
		expect(executions).toHaveLength(1);
	});

	it("does not synthesize success for missing Workflow adapters or unknown work", () => {
		const { driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		expect(driver.reserve(undefined, "receipt")).toBeUndefined();
		expect(driver.snapshot()?.reason).toContain("adapter unavailable");
	});

	it("tracks trusted Workflow activity and charges its result event once", () => {
		const { driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const workflow = { id: "workflow-owned", status: "running" as const, createdAt: 1001 };
		expect(driver.reserve([workflow], "receipt")).toBeUndefined();
		expect(driver.view([workflow]).state).toBe("waiting");
		expect(driver.reserveEvent([workflow.id], "receipt")).toBe(true);
		expect(driver.reserveEvent([workflow.id], "receipt")).toBe(false);
		expect(
			driver.reserve([{ ...workflow, status: "awaiting_result", outcome: "completed" }], "receipt"),
		).toBeUndefined();
		expect(driver.reserve([{ ...workflow, status: "archived", outcome: "completed" }], "receipt")).toBeDefined();
	});

	it("deduplicates individual executor results even when batches overlap or reorder", () => {
		const { driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		driver.trackWorkflows(
			["a", "b", "c"].map((id) => ({ id, status: "awaiting_result", outcome: "completed", createdAt: 1001 })),
		);
		expect(driver.reserveEvent(["a", "b"], "receipt")).toBe(true);
		expect(driver.reserveEvent(["b", "a"], "receipt")).toBe(false);
		expect(driver.reserveEvent(["a"], "receipt")).toBe(false);
		expect(driver.reserveEvent(["b", "c"], "receipt")).toBe(true);
		expect(driver.snapshot()?.used).toBe(2);
	});

	it("supports nested plan leaves and cannot turn an executor's leaf into a parent", async () => {
		const { manager, root, storageRoot } = setup();
		const phase = manager.createTask("phase", [], root.id);
		const leaf = manager.createTask("leaf", [], phase.id);
		manager.start({ command: "verify", label: "verify", cwd: storageRoot, parentTaskId: root.id, taskId: leaf.id });
		await tick();
		expect(taskDisplayState(manager.get(root.id), manager.list())).toBe("task:waiting-job");
		expect(taskDisplayState(manager.get(phase.id), manager.list())).toBe("task:waiting-job");
		expect(() => manager.createTask("late child", [], leaf.id)).toThrow("leaf");
		expect(() =>
			manager.start({ command: "second", label: "second", cwd: storageRoot, parentTaskId: leaf.id }),
		).toThrow("leaf");
	});

	it("a stopped logical task cannot be reset to pending and replayed", () => {
		const { manager, root } = setup();
		const leaf = manager.createTask("cancelled", [], root.id);
		manager.updateTask(leaf.id, "stopped");
		expect(() => manager.updateTask(leaf.id, "pending")).toThrow("stopped result");
		manager.acknowledge(leaf.id, "Cancelled work retained");
		expect(() => manager.updateTask(leaf.id, "pending")).toThrow("Archived");
	});

	it("restores actual task checkpoints without starting recovered jobs", async () => {
		const { manager, root, storageRoot, executions } = setup();
		manager.start({ command: "verify", label: "verify", cwd: storageRoot, parentTaskId: root.id });
		await tick();
		const restored = new TaskManager({
			storageRoot,
			sessionId: "continuity",
			operations: {
				exec: async () => {
					throw new Error("must not dispatch");
				},
			},
		});
		managers.push(restored);
		expect(restored.get(root.id)).toMatchObject({
			summary: "checkpoint",
			phase: "phase-1",
			nextAction: { key: "step-1" },
		});
		expect(restored.descendants(root.id).some((entry) => entry.status === "unknown")).toBe(true);
		expect(() => new TaskContinuation(restored).activate(root.id, "receipt", "user-command")).toThrow("unknown");
		expect(executions).toHaveLength(1);
	});

	it("pause revokes in-memory authorization even if durable storage becomes unavailable", () => {
		const { manager, driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const failing = vi
			.spyOn(manager, "continuityPath")
			.mockReturnValue(join(manager.continuityPath(), "missing", "file"));
		expect(() => driver.pause("storage failed during abort")).toThrow();
		expect(driver.snapshot()?.state).toBe("paused");
		expect(driver.reserve([], "receipt")).toBeUndefined();
		failing.mockRestore();
	});

	it("rejects a ledger that would be too large to restore instead of saving unreadable state", () => {
		const { manager, driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const before = readFileSync(manager.continuityPath(), "utf8");
		const oversized = Array.from({ length: 1000 }, (_, i) => ({
			id: `${"\u0000".repeat(195)}${i}`,
			status: "running" as const,
			createdAt: 1001,
		}));
		expect(() => driver.trackWorkflows(oversized)).toThrow("size limit");
		expect(readFileSync(manager.continuityPath(), "utf8")).toBe(before);
		expect(driver.snapshot()?.used).toBe(0);
	});

	it("cannot reserve a boundary message if durable accounting cannot be saved", () => {
		const { manager, driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const failing = vi
			.spyOn(manager, "continuityPath")
			.mockReturnValue(join(manager.continuityPath(), "missing-parent", "file"));
		expect(() => driver.reserve([], "receipt")).toThrow();
		expect(driver.snapshot()?.used).toBe(0);
		failing.mockRestore();
	});
});
