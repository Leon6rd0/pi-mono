import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChildRunner } from "../../examples/extensions/workflow/child-agent.ts";
import { createWorkflowExtension } from "../../examples/extensions/workflow/index.ts";
import type { WorkflowRecord } from "../../examples/extensions/workflow/types.ts";
import { createChildResourceSnapshot } from "../../src/core/child-resources.ts";
import { ChildToolScope } from "../../src/core/child-tool-scope.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolCallEvent,
	ToolResultEvent,
} from "../../src/core/extensions/types.ts";
import { VIRTUAL_MODULES } from "../../src/core/extensions/virtual-modules.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestResourceLoader } from "../utilities.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const scopes: ChildToolScope[] = [];
const directories: string[] = [];
function directory() {
	const path = mkdtempSync(join(tmpdir(), "workflow-host-"));
	directories.push(path);
	return path;
}
async function setup(factory: ExtensionFactory | ExtensionFactory[] = () => {}, customBackend = false) {
	const harness = await createHarness({
		tools: customBackend ? [] : undefined,
		initialActiveToolNames: ["read", "grep", "find", "ls", "edit", "write"],
		extensionFactories: Array.isArray(factory) ? factory : [factory],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext() });
	return harness;
}
function createScope(harness: Harness, cwd = harness.tempDir) {
	const ctx = harness.session.extensionRunner.createContext();
	const source = new AbortController();
	const host = ctx.createChildToolHost!({
		cwd,
		signal: source.signal,
		model: harness.getModel(),
		thinkingLevel: "off",
	});
	const resources = createChildResourceSnapshot(host.resources, { cwd, role: "worker" });
	const scope = new ChildToolScope({
		identity: {
			id: `child-${scopes.length}`,
			cwd,
			role: "worker",
			epoch: resources.epoch,
			backendId: host.getState().backendId,
		},
		resources,
		host,
		signal: host.signal,
		allowWrites: true,
		writeAccess: true,
	});
	scopes.push(scope);
	return { scope, host, source };
}
function passiveLoader(harness: Harness, agentDir: string) {
	const loader = new DefaultResourceLoader({
		cwd: harness.tempDir,
		agentDir,
		settingsManager: harness.settingsManager,
		noExtensions: true,
	});
	// The harness's loader delegates passive resolution to the actual configured loader,
	// not a mocked child host or a guessed process-global agent directory. No reload/discovery.
	harness.session.resourceLoader.getChildContextFiles = (cwd) => loader.getChildContextFiles(cwd);
	return loader;
}
function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

afterEach(async () => {
	vi.restoreAllMocks();
	for (const scope of scopes.splice(0)) await scope.close();
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("real session child host (faux/local only)", () => {
	it("exposes source child primitives through the actual extension virtual SDK", () => {
		expect(VIRTUAL_MODULES["@earendil-works/pi-coding-agent"]).toMatchObject({
			ChildToolScope,
			createChildResourceSnapshot,
			childWorkspacePath: expect.any(Function),
		});
	});
	it("runs shared denial with child ownership and zero raw write dispatches", async () => {
		let observed: ExtensionContext | undefined;
		const h = await setup(
			(pi) =>
				void pi.on("tool_call", (_event, ctx) => {
					if (ctx.childScope) {
						observed = ctx;
						return { block: true };
					}
				}),
		);
		const { scope } = createScope(h);
		await expect(scope.execute("parent-id", "write", { path: "denied.txt", content: "no" })).rejects.toThrow(
			"denied",
		);
		expect(existsSync(join(h.tempDir, "denied.txt"))).toBe(false);
		expect(scope.snapshot().calls).toMatchObject([{ id: "child-0/1", dispatched: false, effects: "not_started" }]);
		expect(observed?.childScope).toEqual(scope.identity);
		expect(observed?.cwd).toBe(h.tempDir);
		expect(observed?.signal).not.toBe(h.session.agent.signal);
		expect(() => observed?.compact()).toThrow("Parent session controls");
		expect(h.session.messages).toHaveLength(0);
	});

	it.each([false, true])("filters raw filesystem results and fails closed on filter failure=%s", async (fail) => {
		const h = await setup(
			(pi) =>
				void pi.on("tool_result", (_event, ctx) => {
					if (!ctx.childScope) return;
					if (fail) throw new Error("FILTER_PRIVATE_SENTINEL");
					return { content: [{ type: "text", text: "redacted" }] };
				}),
		);
		writeFileSync(join(h.tempDir, "secret.txt"), "RAW_PRIVATE_SENTINEL");
		const { scope } = createScope(h);
		const result = await scope
			.execute("read-1", "read", { path: "secret.txt" })
			.catch((error: Error) => ({ error: error.message, cause: error.cause }));
		expect(JSON.stringify(result)).not.toContain("PRIVATE_SENTINEL");
		if (fail)
			expect(result).toMatchObject({ error: "Child tool execution or result delivery failed", cause: undefined });
		else expect(result).toMatchObject({ content: [{ type: "text", text: "redacted" }] });
		expect(scope.snapshot().calls[0].delivery).toBe(fail ? "failed" : "delivered");
	});

	it.each(["tool_call", "tool_result"] as const)(
		"does not let %s relabel the immutable approved target",
		async (kind) => {
			const h = await setup((pi) => {
				const retarget = (event: ToolCallEvent | ToolResultEvent, ctx: ExtensionContext) => {
					if (ctx.childScope) event.input = { path: "benign.txt" };
				};
				if (kind === "tool_call") pi.on("tool_call", retarget);
				else pi.on("tool_result", retarget);
			});
			writeFileSync(join(h.tempDir, "secret.txt"), "RAW_PRIVATE_SENTINEL");
			const { scope } = createScope(h);
			await expect(scope.execute("retarget", "read", { path: "secret.txt" })).rejects.toThrow();
			expect(scope.snapshot().calls[0].dispatched).toBe(kind === "tool_result");
			expect(scope.snapshot().calls[0].delivery).toBe("failed");
		},
	);

	it.each(["grant", "registration", "runtime", "child", "symlink"] as const)(
		"rechecks %s after queued approval before raw execution",
		async (change) => {
			const entered = gate();
			const approval = gate();
			let api!: ExtensionAPI;
			const h = await setup((pi) => {
				api = pi;
				pi.on("tool_call", async (_event, ctx) => {
					if (ctx.childScope) {
						entered.release();
						await approval.promise;
					}
				});
			});
			const outside = directory();
			const { scope, source } = createScope(h);
			const pending = scope.execute("queued", "write", { path: "target/new.txt", content: "no" });
			const rejected = expect(pending).rejects.toThrow("denied");
			await entered.promise;
			try {
				if (change === "grant") h.session.setActiveToolsByName([]);
				else if (change === "registration") api.on("tool_call", () => ({ block: true }));
				else if (change === "runtime") h.session.extensionRunner.invalidate();
				else if (change === "child") source.abort();
				else symlinkSync(outside, join(h.tempDir, "target"));
			} finally {
				approval.release();
			}
			await rejected;
			expect(scope.snapshot().calls[0].dispatched).toBe(false);
			expect(existsSync(join(outside, "new.txt"))).toBe(false);
			expect(existsSync(join(h.tempDir, "target", "new.txt"))).toBe(false);
		},
	);

	it.each(["same-event", "other-event", "other-owner", "restored"] as const)(
		"rechecks public registration identity after approval: %s",
		async (change) => {
			const entered = gate();
			const approval = gate();
			const apis: ExtensionAPI[] = [];
			let unregister!: () => void;
			const handler = async (_event: ToolCallEvent | ToolResultEvent, ctx: ExtensionContext) => {
				if (ctx.childScope) {
					entered.release();
					await approval.promise;
				}
			};
			const h = await setup([
				(pi) => {
					apis.push(pi);
					unregister = pi.on("tool_call", handler);
				},
				(pi) => {
					apis.push(pi);
				},
			]);
			const { scope } = createScope(h);
			const pending = scope.execute("registration", "write", { path: "registration.txt", content: "allowed" });
			const checked =
				change === "restored"
					? expect(pending).resolves.toMatchObject({ content: expect.any(Array) })
					: expect(pending).rejects.toThrow("denied");
			await entered.promise;
			try {
				if (change === "restored") {
					const removeTemporary = apis[0].on("tool_call", handler);
					removeTemporary();
				} else {
					unregister();
					if (change === "other-event") apis[0].on("tool_result", handler);
					else apis[change === "other-owner" ? 1 : 0].on("tool_call", handler);
				}
			} finally {
				approval.release();
			}
			await checked;
			expect(scope.snapshot().calls[0].dispatched).toBe(change === "restored");
			expect(existsSync(join(h.tempDir, "registration.txt"))).toBe(change === "restored");
		},
	);

	it.each(["remove", "reregister"] as const)(
		"rejects result delivery after public filter %s during its await",
		async (change) => {
			const entered = gate();
			const filtering = gate();
			let api!: ExtensionAPI;
			let unregister!: () => void;
			const filter = async (_event: ToolResultEvent, ctx: ExtensionContext) => {
				if (!ctx.childScope) return;
				entered.release();
				await filtering.promise;
				return { content: [{ type: "text" as const, text: "redacted" }] };
			};
			const h = await setup((pi) => {
				api = pi;
				unregister = pi.on("tool_result", filter);
			});
			writeFileSync(join(h.tempDir, "secret.txt"), "RAW_PRIVATE_SENTINEL");
			const { scope } = createScope(h);
			const pending = scope.execute("filter-registration", "read", { path: "secret.txt" });
			const checked = expect(pending).rejects.toThrow("Child tool execution or result delivery failed");
			await entered.promise;
			try {
				unregister();
				if (change === "reregister") api.on("tool_result", filter);
			} finally {
				filtering.release();
			}
			await checked;
			expect(scope.snapshot().calls[0]).toMatchObject({
				dispatched: true,
				delivery: "failed",
				effects: "read_only",
			});
		},
	);

	it("child stop dismisses shared UI approval without taking the parent turn's signal", async () => {
		const entered = gate();
		const h = await setup(
			(pi) =>
				void pi.on("tool_call", async (_event, ctx) => {
					if (ctx.childScope) return { block: !(await ctx.ui.confirm("Child write", "Allow?")) };
				}),
		);
		h.session.extensionRunner.setUIContext(
			createTestUiContext({
				confirm: (_title, _message, options) =>
					new Promise<boolean>((resolve) => {
						options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
						entered.release();
					}),
			}),
			"rpc",
		);
		const { scope } = createScope(h);
		const pending = scope.execute("approval", "write", { path: "unapproved.txt", content: "no" });
		const rejected = expect(pending).rejects.toThrow("denied");
		await entered.promise;
		await h.session.abort();
		expect(scope.signal.aborted).toBe(false);
		await scope.close();
		await rejected;
		expect(scope.snapshot().calls[0].dispatched).toBe(false);
	});

	it("actual session reload cancels an independent approval and leaves zero raw dispatches", async () => {
		const entered = gate();
		const h = await setup(
			(pi) =>
				void pi.on("tool_call", async (_event, ctx) => {
					if (!ctx.childScope) return;
					await new Promise<void>((resolve) => {
						ctx.signal?.addEventListener("abort", () => resolve(), { once: true });
						entered.release();
					});
				}),
		);
		const loader = h.session.resourceLoader;
		loader.reload = async () => {
			// Like a real reload, replace the invalidated extension runtime rather than reuse it.
			const fresh = createTestResourceLoader();
			loader.getExtensions = () => fresh.getExtensions();
		};
		const { scope } = createScope(h);
		const pending = scope.execute("reload", "write", { path: "no.txt", content: "no" });
		const rejected = expect(pending).rejects.toThrow("denied");
		await entered.promise;
		await h.session.reload();
		await rejected;
		expect(scope.signal.aborted).toBe(true);
		expect(scope.snapshot().calls[0].dispatched).toBe(false);
	});

	it("closes the host on resource setup failure before any model admission", async () => {
		const h = await setup();
		h.session.resourceLoader.getAgentsFiles = () => ({
			agentsFiles: [{ path: "host:oversize", content: "x".repeat(128 * 1024 + 1) }],
		});
		const ctx = h.session.extensionRunner.createContext();
		let signal: AbortSignal | undefined;
		const run = createChildRunner(ctx.modelRegistry, h.getModel(), (options) => {
			const host = ctx.createChildToolHost!(options);
			signal = host.signal;
			return host;
		});
		const beforeRequest = vi.fn(async () => "not-admitted");
		await expect(
			run({
				id: "setup-failure",
				request: { prompt: "Inspect", role: "scout" },
				thinkingLevel: "off",
				cwd: h.tempDir,
				writeAccess: false,
				maxTurns: 1,
				maxOutputTokens: 64,
				signal: new AbortController().signal,
				beforeRequest,
				onUsage: () => {},
			}),
		).rejects.toThrow("byte limit");
		expect(beforeRequest).not.toHaveBeenCalled();
		expect(signal?.aborted).toBe(true);
	});

	it.each([false, true])(
		"unsubscribes the real child when progress fails, including interrupt=%s",
		async (failOnInterrupt) => {
			const policy = vi.fn(() => undefined);
			const h = await setup((pi) => {
				pi.on("tool_call", policy);
			});
			writeFileSync(join(h.tempDir, "fixture.txt"), "not dispatched");
			h.setResponses([
				fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" }),
			]);
			const unsubscribed = vi.fn();
			const originalSubscribe = Agent.prototype.subscribe;
			vi.spyOn(Agent.prototype, "subscribe").mockImplementation(function (this: Agent, listener) {
				const unsubscribe = originalSubscribe.call(this, listener);
				return () => {
					unsubscribe();
					unsubscribed();
				};
			});
			let closedScope: ChildToolScope | undefined;
			const originalClose = ChildToolScope.prototype.close;
			vi.spyOn(ChildToolScope.prototype, "close").mockImplementation(function (this: ChildToolScope) {
				closedScope = this;
				return originalClose.call(this);
			});
			const ctx = h.session.extensionRunner.createContext();
			let hostSignal: AbortSignal | undefined;
			const run = createChildRunner(ctx.modelRegistry, h.getModel(), (options) => {
				const host = ctx.createChildToolHost!(options);
				hostSignal = host.signal;
				return host;
			});
			const source = new AbortController();
			const statuses: string[] = [];
			await expect(
				run({
					id: "progress-failure",
					request: { prompt: "Read fixture.txt", role: "scout" },
					thinkingLevel: "off",
					cwd: h.tempDir,
					writeAccess: false,
					maxTurns: 1,
					maxOutputTokens: 256,
					signal: source.signal,
					beforeRequest: async () => "progress-request",
					onUsage: () => {},
					onProgress: (progress) => {
						const status = progress.operations[0]?.status;
						if (status) statuses.push(status);
						if (status === "started") throw new Error("start checkpoint failed");
						if (status === "unknown" && failOnInterrupt) throw new Error("interrupt checkpoint failed");
					},
				}),
			).rejects.toThrow(failOnInterrupt ? "interrupt checkpoint failed" : "start checkpoint failed");
			expect(statuses).toEqual(["started", "unknown"]);
			expect(unsubscribed).toHaveBeenCalledOnce();
			expect(closedScope?.identity.id).toBe("progress-failure");
			expect(closedScope?.snapshot()).toMatchObject({ closed: true, pending: 0, calls: [] });
			expect(hostSignal?.aborted).toBe(true);
			expect(source.signal.aborted).toBe(false);
			expect(policy).not.toHaveBeenCalled();
			expect(h.faux.state.callCount).toBe(1);
			expect(h.getPendingResponseCount()).toBe(0);
			expect(h.session.messages).toHaveLength(0);
		},
	);

	it("rechecks host lifetime after model admission and before provider handoff", async () => {
		const h = await setup();
		const ctx = h.session.extensionRunner.createContext();
		const run = createChildRunner(ctx.modelRegistry, h.getModel(), ctx.createChildToolHost);
		const dispatched = vi.fn();
		const admitted = vi.fn(async () => {
			h.session.extensionRunner.invalidate();
			return "reserved-but-not-sent";
		});
		await expect(
			run({
				id: "admission-revoke",
				request: { prompt: "Inspect", role: "scout" },
				thinkingLevel: "off",
				cwd: h.tempDir,
				writeAccess: false,
				maxTurns: 1,
				maxOutputTokens: 64,
				signal: new AbortController().signal,
				beforeRequest: admitted,
				onRequestDispatched: dispatched,
				onUsage: () => {},
			}),
		).rejects.toThrow();
		expect(admitted).toHaveBeenCalledOnce();
		expect(dispatched).not.toHaveBeenCalled();
		expect(h.faux.state.callCount).toBe(0);
	});

	it.each(["custom", "replacement"] as const)(
		"rejects %s backends instead of recreating local tools",
		async (kind) => {
			const body = vi.fn(async () => ({ content: [{ type: "text" as const, text: "remote" }], details: {} }));
			const h = await setup((pi) => {
				if (kind === "replacement")
					pi.registerTool({
						name: "read",
						label: "remote",
						description: "Remote backend",
						parameters: Type.Object({ path: Type.String() }),
						execute: body,
					});
			}, kind === "custom");
			expect(() => createScope(h)).toThrow(/cannot rebind/);
			expect(body).not.toHaveBeenCalled();
			expect(h.faux.state.callCount).toBe(0);
		},
	);

	it("resolves cross-cwd constraints with the actual agentDir, never executable child resources or parent text", async () => {
		const h = await setup();
		const cwd = directory();
		const agentDir = join(h.tempDir, "explicit-agent-dir");
		mkdirSync(agentDir);
		writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL_CONSTRAINT");
		writeFileSync(join(h.tempDir, "AGENTS.md"), "PARENT_ONLY_CONSTRAINT");
		writeFileSync(join(cwd, "AGENTS.md"), "CHILD_CONSTRAINT");
		mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "extensions", "must-not-load.ts"), "throw new Error('EXECUTABLE_CHILD_LOADED');");
		passiveLoader(h, agentDir);
		const { scope, host } = createScope(h, cwd);
		expect(scope.resources.prompt).toContain("GLOBAL_CONSTRAINT");
		expect(scope.resources.prompt).toContain("CHILD_CONSTRAINT");
		expect(scope.resources.prompt).not.toContain("PARENT_ONLY_CONSTRAINT");
		expect(host.resources.projectTrusted).toBe(false);
		expect(host.resources.skills).toEqual([]);
		await scope.execute("local-write", "write", { path: "owned.txt", content: "child cwd" });
		expect(readFileSync(join(cwd, "owned.txt"), "utf8")).toBe("child cwd");
		expect(existsSync(join(h.tempDir, "owned.txt"))).toBe(false);
		const overridden = new DefaultResourceLoader({
			cwd: h.tempDir,
			agentDir,
			settingsManager: h.settingsManager,
			agentsFilesOverride: () => ({ agentsFiles: [] }),
		});
		expect(() => overridden.getChildContextFiles(cwd)).toThrow("cannot be rebased");
		symlinkSync(join(cwd, "missing-constraint"), join(cwd, "AGENTS.override.md"));
		expect(() => h.session.resourceLoader.getChildContextFiles!(cwd)).toThrow();
	});

	it("uses the production Workflow start -> real Agent -> shared hooks path after the parent turn ends", async () => {
		const storageRoot = directory();
		const cwd = directory();
		let observations = 0;
		const parentDone = gate();
		const h = await setup((pi) => {
			createWorkflowExtension({ storageRoot, notifyModel: false })(pi);
			pi.on("tool_call", async (event, ctx) => {
				if (ctx.childScope) {
					observations++;
					expect(ctx.cwd).toBe(cwd);
					expect(event.toolName).toBe("read");
					await parentDone.promise;
					expect(h.session.isIdle).toBe(true);
				}
			});
			pi.on("tool_result", (_event, ctx) => {
				if (ctx.childScope) return { content: [{ type: "text", text: "HOST_FILTERED" }] };
			});
		});
		const agentDir = join(h.tempDir, "agent");
		mkdirSync(agentDir);
		writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_AXIS_CONSTRAINT");
		writeFileSync(join(cwd, "fixture.txt"), "RAW_PRIVATE_SENTINEL");
		passiveLoader(h, agentDir);
		// No runChild override: all three remaining responses route by the actual caller,
		// avoiding an ordering assumption between the parent follow-up and detached child.
		h.setResponses([
			fauxAssistantMessage(
				fauxToolCall("workflow", {
					action: "start",
					label: "real host",
					cwd,
					code: "return await agent('Read fixture.txt', {role:'scout'});",
				}),
				{ stopReason: "toolUse" },
			),
			...[0, 1, 2].map(() => (context: TranscriptContext) => {
				if (getCurrentTools(context.messages).some((tool) => tool.name === "workflow"))
					return fauxAssistantMessage("Parent remains available");
				const text = JSON.stringify(context.messages);
				expect(text).not.toContain("PARENT_PRIVATE_HISTORY");
				expect(text).not.toContain("RAW_PRIVATE_SENTINEL");
				expect(text).toContain("PROJECT_AXIS_CONSTRAINT");
				if (text.includes("HOST_FILTERED")) return fauxAssistantMessage("Verified detached child");
				return fauxAssistantMessage(fauxToolCall("read", { path: "fixture.txt" }), { stopReason: "toolUse" });
			}),
		]);
		try {
			await h.session.prompt("PARENT_PRIVATE_HISTORY: launch the bounded workflow");
		} finally {
			parentDone.release();
		}
		const result = getToolResult(h, "workflow");
		expect(result.isError).toBe(false);
		const { resultPath } = result.details as { resultPath: string };
		let record!: WorkflowRecord;
		await vi.waitFor(() => {
			record = JSON.parse(readFileSync(resultPath, "utf8")) as WorkflowRecord;
			expect(record.status).toBe("awaiting_result");
		});
		expect(record.outcome).toBe("completed");
		expect(JSON.stringify(record)).not.toContain("RAW_PRIVATE_SENTINEL");
		expect(record.result).toContain("Verified detached child");
		expect(observations).toBe(1);
		expect(record.agents[0].requests).toHaveLength(2);
		expect(h.getPendingResponseCount()).toBe(0);
	});
});
