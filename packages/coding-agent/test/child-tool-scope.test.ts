import { inspect } from "node:util";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { type ChildRole, createChildResourceSnapshot } from "../src/core/child-resources.ts";
import {
	CHILD_TOOL_SCOPE_LIMITS,
	type ChildToolHostState,
	type ChildToolInvocation,
	ChildToolScope,
	type ChildToolScopeHost,
} from "../src/core/child-tool-scope.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
const result = (text = "ok"): AgentToolResult<unknown> => ({ content: [{ type: "text", text }], details: {} });

function setup(options: { role?: ChildRole; allowWrites?: boolean; writeAccess?: boolean; names?: string[] } = {}) {
	const identity = {
		id: "child-1",
		cwd: "/project",
		epoch: "session:1",
		role: options.role ?? "scout",
		backendId: "explicit-test-backend",
	};
	const resources = createChildResourceSnapshot(
		{ ...identity, projectTrusted: true, instructions: [], skills: [] },
		identity,
	);
	const state: ChildToolHostState = {
		...identity,
		projectTrusted: true,
		toolNames: options.names ?? ["read", "grep", "find", "ls", "edit", "write", "bash", "mcp", "workflow"],
	};
	const executed = vi.fn(
		async (_id: string, _args: unknown, _signal?: AbortSignal): Promise<AgentToolResult<unknown>> => result(),
	);
	const tools: AgentTool[] = state.toolNames.map((name) => ({
		name,
		label: name,
		description: name,
		parameters: Type.Object({ path: Type.String() }),
		execute: executed,
	}));
	const host: ChildToolScopeHost = {
		tools,
		getState: () => state,
		checkCall: () => true,
		authorize: async () => ({ allow: true }),
		filterResult: async (_call, value) => value,
	};
	const controller = new AbortController();
	const scopeOptions = {
		identity,
		resources,
		signal: controller.signal,
		allowWrites: options.allowWrites ?? false,
		writeAccess: options.writeAccess ?? false,
		host,
	};
	return { scope: new ChildToolScope(scopeOptions), scopeOptions, host, state, tools, executed, controller };
}

describe("detached child tool scope", () => {
	it.each<ChildRole>(["scout", "reviewer", "summarizer"])(
		"does not grant mutation, shell, MCP or delegation to %s",
		async (role) => {
			const { scope, executed } = setup({ role, allowWrites: true, writeAccess: true });
			expect(scope.tools.map((tool) => tool.name)).toEqual(["read", "grep", "find", "ls"]);
			await expect(scope.execute("w", "write", { path: "x" })).rejects.toThrow("ceiling");
			expect(executed).not.toHaveBeenCalled();
			await scope.close();
		},
	);

	it.each([
		[false, false],
		[true, false],
		[false, true],
		[true, true],
	])("requires both write permissions (%s, %s) for a worker", async (allowWrites, writeAccess) => {
		const { scope } = setup({ role: "worker", allowWrites, writeAccess });
		expect(scope.tools.some((tool) => tool.name === "write")).toBe(allowWrites && writeAccess);
		expect(scope.tools.some((tool) => tool.name === "bash")).toBe(false);
		await scope.close();
	});

	it("does not silently add newly enabled host tools", async () => {
		const { scope, state, executed } = setup({ names: ["read"] });
		state.toolNames = ["read", "write", "grep"];
		await expect(scope.execute("g", "grep", { path: "x" })).rejects.toThrow("ceiling");
		expect(scope.tools.map((tool) => tool.name)).toEqual(["read"]);
		expect(executed).not.toHaveBeenCalled();
		await scope.close();
	});

	it("denied shared policy executes zero times", async () => {
		const { scope, host, executed } = setup();
		host.authorize = async () => ({ allow: false, reason: "protected" });
		await expect(scope.execute("r", "read", { path: "protected" })).rejects.toThrow("denied");
		expect(executed).not.toHaveBeenCalled();
		expect(scope.snapshot().calls).toMatchObject([
			{ state: "denied", dispatched: false, delivery: "failed", effects: "not_started" },
		]);
		await scope.close();
	});

	it.each(["throw", "missing", "unavailable UI"])("fails closed on an approval %s", async (failure) => {
		const { scope, host, executed } = setup();
		host.authorize =
			failure === "missing"
				? ((async () => undefined) as unknown as ChildToolScopeHost["authorize"])
				: async () => {
						throw new Error(failure);
					};
		await expect(scope.execute("r", "read", { path: "x" })).rejects.toThrow("denied");
		expect(executed).not.toHaveBeenCalled();
		await scope.close();
	});

	it("validates arguments before asking the host, and prepares once", async () => {
		const { scopeOptions, scope: initial, host, executed } = setup();
		await initial.close();
		const prepare = vi.fn((args: unknown) => args);
		host.tools[0].prepareArguments = prepare;
		const authorize = vi.fn(host.authorize);
		host.authorize = authorize;
		const scope = new ChildToolScope(scopeOptions);
		await expect(scope.execute("invalid", "read", { noPath: "x" })).rejects.toThrow("denied");
		expect(authorize).not.toHaveBeenCalled();
		await scope.tools[0].execute("valid", { path: "x" });
		expect(prepare).toHaveBeenCalledTimes(2);
		expect(authorize).toHaveBeenCalledTimes(1);
		expect(executed).toHaveBeenCalledTimes(1);
		await scope.close();
	});

	it("checks live protected paths again after asynchronous approval", async () => {
		const { scope, host, executed } = setup();
		const entered = deferred();
		const approval = deferred();
		let protectedPath = false;
		host.checkCall = (call) => !protectedPath || call.args.path !== "x";
		host.authorize = async () => {
			entered.resolve();
			await approval.promise;
			return { allow: true };
		};
		const pending = scope.execute("r", "read", { path: "x" });
		const rejected = expect(pending).rejects.toThrow("denied");
		await entered.promise;
		protectedPath = true;
		approval.resolve();
		await rejected;
		expect(executed).not.toHaveBeenCalled();
		await scope.close();
	});

	it("rechecks revocation after queue waits and never restores an observed revoked grant", async () => {
		const { scope, state, host, executed } = setup();
		const entered = deferred();
		const approval = deferred();
		host.authorize = async () => {
			entered.resolve();
			await approval.promise;
			return { allow: true };
		};
		const first = expect(scope.execute("r1", "read", { path: "x" })).rejects.toThrow("denied");
		await entered.promise;
		const second = expect(scope.execute("r2", "read", { path: "x" })).rejects.toThrow("denied");
		state.toolNames = [];
		approval.resolve();
		await Promise.all([first, second]);
		state.toolNames = ["read"];
		await expect(scope.execute("r3", "read", { path: "x" })).rejects.toThrow("denied");
		expect(executed).not.toHaveBeenCalled();
		await scope.close();
	});

	it("caller signal cannot replace child cancellation, and close drains actual outstanding approval", async () => {
		const { scope, host, executed, controller } = setup();
		const entered = deferred();
		const approval = deferred();
		let observed: AbortSignal | undefined;
		host.authorize = async (call) => {
			observed = call.signal;
			entered.resolve();
			await approval.promise;
			return { allow: true };
		};
		const pending = expect(scope.execute("r", "read", { path: "x" }, new AbortController().signal)).rejects.toThrow(
			"denied",
		);
		await entered.promise;
		controller.abort();
		let drained = false;
		const closing = scope.close().then(() => {
			drained = true;
		});
		expect(observed?.aborted).toBe(true);
		expect(drained).toBe(false);
		await expect(scope.execute("late", "read", { path: "x" })).rejects.toThrow("closed");
		approval.resolve();
		await pending;
		await closing;
		expect(drained).toBe(true);
		expect(executed).not.toHaveBeenCalled();
		expect(scope.snapshot().pending).toBe(0);
	});

	it("does not dispatch after a synchronous host callback cancels the scope", async () => {
		const { scope, host, executed } = setup();
		host.checkCall = () => {
			void scope.close();
			return true;
		};
		await expect(scope.execute("r", "read", { path: "x" })).rejects.toThrow("denied");
		expect(executed).not.toHaveBeenCalled();
		await scope.close();
	});

	it("a per-call abort does not cancel the child or its next call", async () => {
		const { scope, executed } = setup();
		const caller = new AbortController();
		caller.abort();
		await expect(scope.execute("r1", "read", { path: "x" }, caller.signal)).rejects.toThrow("denied");
		await scope.execute("r2", "read", { path: "x" });
		expect(scope.signal.aborted).toBe(false);
		expect(executed).toHaveBeenCalledTimes(1);
		await scope.close();
	});

	it.each(["cwd", "epoch", "backendId", "projectTrusted"] as const)(
		"invalidates stale %s scopes without local fallback",
		async (field) => {
			const { scope, state, executed } = setup();
			if (field === "projectTrusted") state.projectTrusted = false;
			else state[field] = "changed";
			await expect(scope.execute("r", "read", { path: "x" })).rejects.toThrow("stale");
			expect(scope.signal.aborted).toBe(true);
			expect(executed).not.toHaveBeenCalled();
			await scope.close();
		},
	);

	it("rejects missing policy adapters and resource/backend scope mismatches", async () => {
		const { scope, scopeOptions, host } = setup();
		expect(
			() =>
				new ChildToolScope({
					...scopeOptions,
					host: { ...host, authorize: undefined } as unknown as ChildToolScopeHost,
				}),
		).toThrow("complete host");
		expect(
			() => new ChildToolScope({ ...scopeOptions, identity: { ...scopeOptions.identity, cwd: "/other" } }),
		).toThrow("mismatch");
		expect(
			() =>
				new ChildToolScope({
					...scopeOptions,
					identity: { ...scopeOptions.identity, backendId: "local-fallback" },
				}),
		).toThrow("stale");
		await scope.close();
	});

	it("captures identity and arguments instead of following caller mutations or parent-turn data", async () => {
		const { scope, host, executed, scopeOptions } = setup();
		const entered = deferred();
		const approval = deferred();
		let observed: ChildToolInvocation | undefined;
		host.authorize = async (call) => {
			observed = call;
			entered.resolve();
			await approval.promise;
			return { allow: true };
		};
		const args = { path: "original" };
		const pending = scope.execute("r", "read", args);
		args.path = "mutated";
		scopeOptions.identity.cwd = "/parent-new-turn";
		await entered.promise;
		expect(observed?.scope.cwd).toBe("/project");
		expect(observed?.args.path).toBe("original");
		expect(Object.isFrozen(observed?.args)).toBe(true);
		approval.resolve();
		await pending;
		expect(executed.mock.calls[0][1]).toEqual({ path: "original" });
		await scope.close();
	});

	it("runs captured backend functions, not later replacements", async () => {
		const { scope, tools, executed } = setup();
		const replacement = vi.fn(async () => result("replacement"));
		tools[0].execute = replacement;
		await scope.execute("r", "read", { path: "x" });
		expect(executed).toHaveBeenCalledOnce();
		expect(replacement).not.toHaveBeenCalled();
		await scope.close();
	});

	it("does not leak raw content or partial updates around the result policy", async () => {
		const { scope, host, executed } = setup();
		executed.mockResolvedValue(result("SECRET_SENTINEL"));
		host.filterResult = async () => result("redacted");
		const update = vi.fn();
		const delivered = await scope.tools[0].execute("r", { path: "x" }, undefined, update);
		expect(delivered).toEqual(result("redacted"));
		expect(update).not.toHaveBeenCalled();
		expect(JSON.stringify(scope.snapshot())).not.toContain("SECRET_SENTINEL");
		await scope.close();
	});

	it.each(["backend", "state", "check", "approval", "result"])(
		"does not disclose %s exceptions through messages, causes or attached properties",
		async (stage) => {
			const { scope, host, executed } = setup();
			const sensitive = Object.assign(new Error("SECRET_SENTINEL"), { payload: "SECRET_SENTINEL" });
			const fail = () => {
				throw sensitive;
			};
			if (stage === "backend") executed.mockRejectedValue(sensitive);
			else if (stage === "state") host.getState = fail;
			else if (stage === "check") host.checkCall = fail;
			else if (stage === "approval") host.authorize = fail;
			else host.filterResult = fail;
			const error: unknown = await scope.tools[0].execute("r", { path: "x" }).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toHaveProperty("cause");
			expect(error).not.toHaveProperty("payload");
			expect(inspect(error, { depth: 10, showHidden: true })).not.toContain("SECRET_SENTINEL");
			expect(JSON.stringify(scope.snapshot())).not.toContain("SECRET_SENTINEL");
			await scope.close();
		},
	);

	it("sanitizes host errors while creating a scope, before tool execution exists", async () => {
		const { scope, host, scopeOptions } = setup();
		host.getState = () => {
			throw new Error("HOST_SECRET_SENTINEL");
		};
		expect(() => new ChildToolScope(scopeOptions)).toThrow("stale or unsupported");
		await scope.close();
	});

	it("retains actual mutation evidence when result redaction fails", async () => {
		const { scope, host } = setup({ role: "worker", allowWrites: true, writeAccess: true });
		host.filterResult = async () => {
			throw new Error("REDACTION_SECRET");
		};
		await expect(scope.execute("w", "write", { path: "x" })).rejects.toThrow("delivery failed");
		expect(scope.snapshot().calls).toMatchObject([
			{ state: "completed", dispatched: true, delivery: "failed", effects: "reported_completed" },
		]);
		expect(JSON.stringify(scope.snapshot())).not.toContain("REDACTION_SECRET");
		await scope.close();
	});

	it("rechecks policy after an asynchronous result filter, without claiming rollback", async () => {
		const { scope, host, state } = setup({ role: "worker", allowWrites: true, writeAccess: true });
		host.filterResult = async (_call, value) => {
			state.toolNames = [];
			return value;
		};
		await expect(scope.execute("w", "write", { path: "x" })).rejects.toThrow("delivery failed");
		expect(scope.snapshot().calls).toMatchObject([
			{ state: "completed", delivery: "failed", effects: "reported_completed" },
		]);
		await scope.close();
	});

	it("keeps cancelled in-flight mutations unknown until drain, never assumed rolled back", async () => {
		const { scope, executed } = setup({ role: "worker", allowWrites: true, writeAccess: true });
		const started = deferred();
		const backend = deferred();
		executed.mockImplementation(async () => {
			started.resolve();
			await backend.promise;
			return result();
		});
		const pending = expect(scope.execute("w", "write", { path: "x" })).rejects.toThrow("delivery failed");
		await started.promise;
		const closing = scope.close();
		expect(scope.snapshot().calls).toMatchObject([{ state: "unknown", effects: "unknown" }]);
		expect(scope.snapshot().pending).toBe(1);
		backend.resolve();
		await pending;
		await closing;
		expect(scope.snapshot()).toMatchObject({
			pending: 0,
			closed: true,
			calls: [{ state: "unknown", effects: "unknown", delivery: "failed" }],
		});
	});

	it("bounds the queue, total calls, snapshots and duplicate mutation attempts", async () => {
		const { scope, host, executed } = setup();
		const entered = deferred();
		const approval = deferred();
		host.authorize = async () => {
			entered.resolve();
			await approval.promise;
			return { allow: true };
		};
		const pending = Array.from({ length: CHILD_TOOL_SCOPE_LIMITS.maxPending }, (_, i) =>
			scope.execute(`q${i}`, "read", { path: "x" }),
		);
		await entered.promise;
		await expect(scope.execute("overflow", "read", { path: "x" })).rejects.toThrow("limit");
		approval.resolve();
		await Promise.all(pending);
		await expect(scope.execute("q0", "read", { path: "x" })).rejects.toThrow("repeated");
		for (let i = CHILD_TOOL_SCOPE_LIMITS.maxPending; i < CHILD_TOOL_SCOPE_LIMITS.maxCalls; i++)
			await scope.execute(`r${i}`, "read", { path: "x" });
		await expect(scope.execute("totalOverflow", "read", { path: "x" })).rejects.toThrow("limit");
		expect(executed).toHaveBeenCalledTimes(CHILD_TOOL_SCOPE_LIMITS.maxCalls);
		const snapshot = scope.snapshot();
		expect(snapshot.calls).toHaveLength(CHILD_TOOL_SCOPE_LIMITS.maxRecords);
		expect(snapshot.droppedRecords).toBe(CHILD_TOOL_SCOPE_LIMITS.maxCalls - CHILD_TOOL_SCOPE_LIMITS.maxRecords);
		snapshot.calls[0].state = "unknown";
		expect(scope.snapshot().calls[0].state).toBe("completed");
		await scope.close();
	});
});
