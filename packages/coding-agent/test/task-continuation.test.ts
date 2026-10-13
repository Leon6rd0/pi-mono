import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
		expect(() => driver.activate(root.id, "receipt", "user-command", 129)).toThrow("1–128");
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

	it("recognizes changed instructions with the same phase/key without resetting the finite allowance", () => {
		const { manager, driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command", 3);
		for (const instruction of [
			"Inspect the specified source",
			"Implement the verified correction",
			"Validate the corrected behavior",
		]) {
			manager.updateTask(root.id, undefined, { nextAction: { key: "same-step", instruction } });
			expect(driver.reserve([], "receipt")).toContain(instruction);
			expect(driver.snapshot()?.stalled).toBe(0);
		}
		expect(driver.snapshot()?.used).toBe(3);
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.snapshot()?.reason).toContain("count limit");
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
		time(1000 + CONTINUITY_LIMITS.defaultDurationMinutes * 60_000);
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

	it("a processed failed attempt needs a different corrective checkpoint, not just acknowledgement", async () => {
		const { manager, driver, root, storageRoot, executions } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const leaf = manager.createTask("verify", [], root.id);
		const job = manager.start({
			command: "verify",
			label: "verify",
			cwd: storageRoot,
			parentTaskId: root.id,
			taskId: leaf.id,
		});
		await tick();
		executions[0]({ exitCode: 1 });
		await tick();
		const correction = {
			nextAction: {
				key: "repair",
				instruction: "Correct the fixture identified in the failure log before a new validation",
			},
		};
		expect(driver.reserveEvent([job.id], "receipt")).toBe(true);
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.view([]).state).toBe("awaiting_processing");
		expect(() => driver.recordRecovery(root.id, [job.id], correction, [])).toThrow("acknowledge");
		manager.acknowledge(job.id, "Read failure; incorrect fixture identified, not retried");
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.snapshot()?.state).toBe("armed");
		expect(() =>
			driver.recordRecovery(
				root.id,
				[job.id],
				{ nextAction: { ...manager.get(root.id).nextAction!, key: "new-key-only" } },
				[],
			),
		).toThrow("different corrective");
		expect(() => driver.recordRecovery(root.id, ["invented-id"], correction, [])).toThrow("acknowledge");
		driver.recordRecovery(root.id, [job.id], correction, []);
		expect(driver.reserve([], "receipt")).toContain("Correct the fixture");
		expect(driver.snapshot()).toMatchObject({
			receipt: "receipt",
			resolvedFailures: expect.arrayContaining([job.id, leaf.id]),
		});
		expect(manager.get(job.id).status).toBe("failed");
		expect(manager.get(leaf.id).status).toBe("failed");
		const dependent = manager.createTask("requires successful verify", [leaf.id], root.id);
		expect(() => manager.updateTask(dependent.id, "running")).toThrow("dependencies");
		expect(() => manager.updateTask(leaf.id, "pending")).toThrow("Archived");
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

	it("uses explicit bounded duration/count and preserves old ledger values on reload", () => {
		const { manager, driver, root } = setup();
		expect(driver.activate(root.id, "defaults", "user-command")).toMatchObject({
			limit: 32,
			expiresAt: 1000 + 240 * 60_000,
		});
		const before = driver.snapshot();
		for (const value of [0, 129, 1.5, Number.NaN, Infinity])
			expect(() => driver.activate(root.id, "bad-count", "user-command", value, 60)).toThrow();
		for (const value of [0, 1441, 1.5, Number.NaN, Infinity])
			expect(() => driver.activate(root.id, "bad-time", "user-command", 4, value)).toThrow();
		expect(driver.snapshot()).toEqual(before);
		expect(driver.activate(root.id, "custom", "user-command", 128, 1440)).toMatchObject({
			limit: 128,
			expiresAt: 1000 + 1440 * 60_000,
		});
		const legacy = driver.activate(root.id, "legacy", "user-command", 8, 30);
		delete legacy.resolvedFailures;
		writeFileSync(manager.continuityPath(), JSON.stringify(legacy));
		const restored = new TaskContinuation(manager, () => 1000 + 31 * 60_000);
		expect(restored.snapshot()).toMatchObject({ state: "paused", limit: 8, used: 0, expiresAt: 1000 + 30 * 60_000 });
		expect(restored.reserve([], "legacy")).toBeUndefined();
	});

	it("waiting counts toward the chosen duration but expiry does not stop an active executor", async () => {
		const { manager, driver, root, storageRoot, time, executions } = setup();
		driver.activate(root.id, "receipt", "user-command", 3, 1);
		const job = manager.start({
			command: "controlled",
			label: "controlled",
			cwd: storageRoot,
			parentTaskId: root.id,
		});
		await tick();
		time(60_999);
		expect(driver.view([]).state).toBe("waiting");
		time(61_000);
		expect(driver.reserveEvent([job.id], "receipt")).toBe(false);
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.snapshot()).toMatchObject({ state: "paused", used: 0 });
		expect(manager.get(job.id).status).toBe("running");
		expect(executions).toHaveLength(1);
	});

	it("durably accounts past 16 and rejects an event at the exact chosen cap", () => {
		const { manager, driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command", 17);
		const workflows = Array.from({ length: 18 }, (_, i) => ({
			id: `wf-${i}`,
			createdAt: 1001,
			status: "awaiting_result" as const,
			outcome: "completed" as const,
		}));
		driver.trackWorkflows(workflows);
		for (const entry of workflows.slice(0, 17)) expect(driver.reserveEvent([entry.id], "receipt")).toBe(true);
		expect(JSON.parse(readFileSync(manager.continuityPath(), "utf8"))).toMatchObject({ used: 17, limit: 17 });
		expect(driver.reserveEvent([workflows[17].id], "receipt")).toBe(false);
		expect(driver.snapshot()).toMatchObject({ used: 17, state: "paused" });
	});

	it("an archived failed Workflow needs a corrective checkpoint and retains its failed outcome", () => {
		const { driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const running = { id: "wf-failure", status: "running" as const, createdAt: 1001 };
		driver.trackWorkflows([running]);
		const ready = { ...running, status: "awaiting_result" as const, outcome: "failed" as const };
		expect(driver.reserve([ready], "receipt")).toBeUndefined();
		const archived = { ...ready, status: "archived" as const };
		expect(driver.reserve([archived], "receipt")).toBeUndefined();
		driver.recordRecovery(
			root.id,
			[archived.id],
			{
				nextAction: {
					key: "fix-input",
					instruction: "Repair the invalid review packet path before starting a different review",
				},
			},
			[archived],
		);
		expect(driver.reserve([archived], "receipt")).toContain("Repair the invalid review packet");
		expect(archived.outcome).toBe("failed");
	});

	it.each(["stopped", "unknown"] as const)("archived Workflow %s is not recoverable as a failed step", (outcome) => {
		const { driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const workflow = { id: "wf-unsafe", status: "archived" as const, createdAt: 1001, outcome };
		driver.trackWorkflows([workflow]);
		expect(() =>
			driver.recordRecovery(
				root.id,
				[workflow.id],
				{
					nextAction: {
						key: "unsafe",
						instruction: "Must not treat a stopped or unknown executor as a processed failure",
					},
				},
				[workflow],
			),
		).toThrow("stopped/unknown");
		expect(driver.reserve([workflow], "receipt")).toBeUndefined();
		expect(driver.snapshot()?.state).toBe("blocked");
	});

	it("an acknowledged stopped job still blocks the same grant; only fresh explicit consent can authorize different work", async () => {
		const { manager, driver, root, storageRoot, time, executions } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const job = manager.start({
			command: "controlled",
			label: "controlled",
			cwd: storageRoot,
			parentTaskId: root.id,
		});
		await tick();
		await manager.stop(job.id);
		manager.acknowledge(job.id, "Stopped intentionally, effects inspected");
		expect(driver.reserve([], "receipt")).toBeUndefined();
		expect(driver.snapshot()?.state).toBe("blocked");
		time(Date.now() + 1000);
		manager.updateTask(root.id, undefined, {
			nextAction: { key: "different", instruction: "Inspect a different artifact; do not rerun the stopped job" },
		});
		driver.activate(root.id, "fresh-confirmation", "user-command");
		expect(driver.reserve([], "fresh-confirmation")).toBeDefined();
		expect(manager.get(job.id).status).toBe("stopped");
		expect(executions).toHaveLength(1);
	});

	it("failed resolution persistence cannot authorize the corrected step", () => {
		const { manager, driver, root } = setup();
		driver.activate(root.id, "receipt", "user-command");
		const workflow = { id: "wf-failed", status: "archived" as const, createdAt: 1001, outcome: "failed" as const };
		driver.trackWorkflows([workflow]);
		const failing = vi
			.spyOn(manager, "continuityPath")
			.mockReturnValue(join(manager.continuityPath(), "missing", "file"));
		expect(() =>
			driver.recordRecovery(
				root.id,
				[workflow.id],
				{
					nextAction: {
						key: "fix",
						instruction: "Correct the independently identified failure before new validation",
					},
				},
				[workflow],
			),
		).toThrow();
		failing.mockRestore();
		expect(driver.snapshot()?.resolvedFailures).not.toContain(workflow.id);
		expect(driver.view([workflow]).state).toBe("awaiting_processing");
		expect(driver.reserve([workflow], "receipt")).toBeUndefined();
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
