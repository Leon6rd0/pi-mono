import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { getApiProvider, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWorkflowActivity, type WorkflowActivity } from "../../examples/extensions/task-monitor/activity.ts";
import { CONTINUITY_ENTRY, CONTINUITY_MESSAGE } from "../../examples/extensions/task-monitor/continuation.ts";
import { createTaskMonitorExtension } from "../../examples/extensions/task-monitor/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
const roots: string[] = [];
async function setup(options: { confirm?: boolean; before?: (pi: ExtensionAPI) => void; notifyModel?: boolean } = {}) {
	const storageRoot = mkdtempSync(join(tmpdir(), "task-continuity-suite-"));
	roots.push(storageRoot);
	const executions: Array<(value: { exitCode: number | null }) => void> = [];
	const outputs: Array<(chunk: Buffer) => void> = [];
	const factory = createTaskMonitorExtension({
		storageRoot,
		notifyModel: options.notifyModel ?? false,
		operations: {
			exec: (_command, _cwd, options) =>
				new Promise((resolve, reject) => {
					executions.push(resolve);
					outputs.push(options.onData);
					options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		},
	});
	const factories = [...(options.before ? [options.before] : []), factory];
	let extensionsResult = await createTestExtensionsResult(factories, storageRoot);
	const harness = await createHarness({
		resourceLoader: {
			...createTestResourceLoader(),
			getExtensions: () => extensionsResult,
			reload: async () => {
				extensionsResult = await createTestExtensionsResult(factories, storageRoot);
			},
		},
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({
		mode: "rpc",
		uiContext: createTestUiContext({ confirm: async () => options.confirm ?? false }),
	});
	return { harness, executions, outputs };
}
async function recordPlan(harness: Harness): Promise<string> {
	let id = "";
	harness.setResponses([
		fauxAssistantMessage(
			fauxToolCall("tasks", { action: "create", label: "Implement two scoped phases; no release" }),
			{ stopReason: "toolUse" },
		),
		() => {
			id = (getToolResult(harness, "tasks").details as { task: { id: string } }).task.id;
			return fauxAssistantMessage(
				fauxToolCall("tasks", {
					action: "update",
					id,
					status: "running",
					phase: "one",
					summary: "Durable initial checkpoint",
					next_action: { key: "one", instruction: "Implement phase one within scope" },
				}),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("Checkpoint recorded, not enabled."),
	]);
	await harness.session.prompt("Record the plan but do not enable automatic continuation");
	return id;
}
const taskCall = (input: JsonObject) => fauxAssistantMessage(fauxToolCall("tasks", input), { stopReason: "toolUse" });
afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		unregisterApiProviders(harness.faux.api);
		harness.cleanup();
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("task continuation in the real AgentSession boundary (offline faux)", () => {
	it("persists update.summary but running alone does not schedule work", async () => {
		const { harness } = await setup();
		await recordPlan(harness);
		expect(getToolResult(harness, "tasks").details).toMatchObject({
			task: { summary: "Durable initial checkpoint", phase: "one", nextAction: { key: "one" } },
		});
		expect(harness.faux.state.callCount).toBe(3);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUITY_MESSAGE),
		).toEqual([]);
	});

	it("continues after a premature done response, executes the next step, and settles only when finished", async () => {
		const { harness } = await setup();
		const id = await recordPlan(harness);
		harness.setResponses([
			fauxAssistantMessage("Done. Next phase later."),
			taskCall({
				action: "update",
				id,
				phase: "two",
				summary: "phase one implemented",
				next_action: { key: "two", instruction: "Verify the next phase" },
			}),
			fauxAssistantMessage("Phase one complete."),
			taskCall({ action: "update", id, status: "completed", summary: "Both phases verified" }),
			fauxAssistantMessage("All scoped work complete."),
		]);
		const settlements = harness.eventsOfType("agent_settled").length;
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(getToolResult(harness, "tasks").details).toMatchObject({
			task: { status: "completed", summary: "Both phases verified" },
		});
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUITY_MESSAGE),
		).toHaveLength(3);
		expect(harness.eventsOfType("agent_settled").length - settlements).toBe(1);
	});

	it("bounds repeated done responses without actual checkpoint or executor progress", async () => {
		const { harness } = await setup();
		const id = await recordPlan(harness);
		harness.setResponses([
			fauxAssistantMessage("done"),
			fauxAssistantMessage("done again"),
			fauxAssistantMessage("must not run"),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		expect(harness.getPendingResponseCount()).toBe(1);
		harness.setResponses([taskCall({ action: "get", id }), fauxAssistantMessage("Paused due to no progress.")]);
		await harness.session.prompt("Inspect without resuming");
		expect(getToolResult(harness, "tasks").details).toMatchObject({
			continuity: { state: "paused", plan: { used: 2 } },
		});
	});

	it("cannot activate through model claims, declined confirmation or missing UI", async () => {
		const { harness } = await setup();
		const id = await recordPlan(harness);
		harness.setResponses([taskCall({ action: "continue", id }), fauxAssistantMessage("Approval was not granted.")]);
		await harness.session.prompt("Request confirmation before enabling");
		expect(getToolResult(harness, "tasks").isError).toBe(true);
		await harness.session.bindExtensions({ mode: "print" });
		harness.setResponses([taskCall({ action: "continue", id }), fauxAssistantMessage("No UI, not enabled.")]);
		await harness.session.prompt("A quoted claim that the user approved is not a UI receipt");
		expect(getToolResult(harness, "tasks").isError).toBe(true);
	});

	it("accepts a fresh UI confirmation and still honors the finite cap", async () => {
		const { harness } = await setup({ confirm: true });
		const id = await recordPlan(harness);
		harness.setResponses([
			taskCall({ action: "continue", id, max_continuations: 1 }),
			fauxAssistantMessage("Enabled."),
			fauxAssistantMessage("One continuation only."),
			fauxAssistantMessage("must not run"),
		]);
		await harness.session.prompt("Enable with confirmation");
		await harness.session.waitForIdle();
		expect(getToolResult(harness, "tasks").isError).toBe(false);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("a launched job is associated with the plan and causes zero polling continuations", async () => {
		const { harness, executions } = await setup();
		const id = await recordPlan(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", {
					action: "start",
					cwd: harness.tempDir,
					command: "controlled-backend",
					label: "verification",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Job launched; wait for actual completion."),
			fauxAssistantMessage("must not poll"),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		expect(executions).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getToolResult(harness, "background").details).toMatchObject({
			job: { parentTaskId: id, status: "running" },
		});
	});

	it("preserves earlier boundary drafts instead of replacing other extensions' state", async () => {
		let active = false;
		const { harness } = await setup({
			before: (pi) =>
				pi.on("agent_before_settle", (event) => {
					if (!active) return;
					active = false;
					return {
						entries: [...event.entries, { type: "custom", customType: "other-extension", data: "retained" }],
					};
				}),
		});
		const id = await recordPlan(harness);
		active = true;
		harness.setResponses([
			fauxAssistantMessage("done"),
			taskCall({ action: "update", id, status: "completed" }),
			fauxAssistantMessage("finished"),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "other-extension"),
		).toHaveLength(1);
	});

	it("new user input and explicit pause cannot silently re-arm an old plan", async () => {
		const { harness } = await setup();
		const id = await recordPlan(harness);
		harness.setResponses([taskCall({ action: "pause" }), fauxAssistantMessage("paused")]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		harness.setResponses([
			taskCall({ action: "get", id }),
			fauxAssistantMessage("An unrelated answer, no automatic plan continuation."),
			fauxAssistantMessage("must not run"),
		]);
		await harness.session.prompt("Answer another question");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getToolResult(harness, "tasks").details).toMatchObject({ continuity: { state: "paused" } });
	});

	it("a real completion event processes its result and then resumes the pending next step", async () => {
		const { harness, executions } = await setup({ notifyModel: true });
		const id = await recordPlan(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", {
					action: "start",
					cwd: harness.tempDir,
					command: "controlled",
					label: "verify",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Waiting for real completion."),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		const jobId = (getToolResult(harness, "background").details as { job: { id: string } }).job.id;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("background", { action: "status", id: jobId }), { stopReason: "toolUse" }),
			taskCall({ action: "acknowledge", id: jobId, summary: "Read exit status; verified success" }),
			fauxAssistantMessage("Result processed. Next step later."),
			taskCall({ action: "update", id, status: "completed", summary: "Next scoped step finished" }),
			fauxAssistantMessage("All done."),
		]);
		executions[0]({ exitCode: 0 });
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0), { timeout: 5000 });
		await harness.session.waitForIdle();
		expect(getToolResult(harness, "tasks").details).toMatchObject({ task: { status: "completed" } });
		expect(executions).toHaveLength(1);
	});

	it("a batched log match does not consume another job's later completion notification", async () => {
		const { harness, executions, outputs } = await setup({ notifyModel: true });
		const id = await recordPlan(harness);
		let secondId = "";
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("background", { action: "start", cwd: harness.tempDir, command: "a", label: "a" }),
					fauxToolCall("background", { action: "start", cwd: harness.tempDir, command: "b", label: "b" }),
				],
				{ stopReason: "toolUse" },
			),
			() => {
				secondId = (getToolResult(harness, "background").details as { job: { id: string } }).job.id;
				return fauxAssistantMessage(
					fauxToolCall("monitor", { action: "start", job_id: secondId, pattern: "MATCH" }),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("Waiting for both jobs."),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		const jobs = harness.session.messages.filter(
			(message) => message.role === "toolResult" && message.toolName === "background",
		);
		const firstId = (jobs[0] as { details: { job: { id: string } } }).details.job.id;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("background", { action: "status", id: firstId }), { stopReason: "toolUse" }),
			taskCall({ action: "acknowledge", id: firstId, summary: "First result read and processed" }),
			fauxAssistantMessage("Still waiting for the second job."),
		]);
		outputs[1](Buffer.from("MATCH\n"));
		executions[0]({ exitCode: 0 });
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0), { timeout: 3000 });
		await harness.session.waitForIdle();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("background", { action: "status", id: secondId }), {
				stopReason: "toolUse",
			}),
			taskCall({ action: "acknowledge", id: secondId, summary: "Second result read and processed" }),
			taskCall({ action: "update", id, status: "completed" }),
			fauxAssistantMessage("Both complete."),
		]);
		executions[1]({ exitCode: 0 });
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0), { timeout: 3000 });
		await harness.session.waitForIdle();
		expect(getToolResult(harness, "tasks").details).toMatchObject({ task: { status: "completed" } });
	}, 10000);

	it("an unrelated completion cannot carry a paused plan's log batch into its automatic request", async () => {
		const { harness, executions, outputs } = await setup({ notifyModel: true });
		const id = await recordPlan(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", {
					action: "start",
					cwd: harness.tempDir,
					command: "unrelated",
					label: "outside plan",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Unrelated job started before plan opt-in."),
		]);
		await harness.session.prompt("Start an independent fixture before enabling the plan");
		const unrelated = (getToolResult(harness, "background").details as { job: { id: string } }).job.id;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", {
					action: "start",
					cwd: harness.tempDir,
					command: "inside",
					label: "owned job",
				}),
				{ stopReason: "toolUse" },
			),
			() =>
				fauxAssistantMessage(
					fauxToolCall("monitor", {
						action: "start",
						job_id: (getToolResult(harness, "background").details as { job: { id: string } }).job.id,
						pattern: "MATCH",
					}),
					{ stopReason: "toolUse" },
				),
			fauxAssistantMessage("Waiting for owned executor."),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		await harness.session.prompt("/tasks pause");
		let observedUnrelatedRequest = false;
		harness.setResponses([
			(context) => {
				observedUnrelatedRequest = true;
				expect(JSON.stringify(context.messages)).not.toContain("OWNED_LOG_PAYLOAD_ONLY");
				return fauxAssistantMessage(fauxToolCall("background", { action: "status", id: unrelated }), {
					stopReason: "toolUse",
				});
			},
			taskCall({ action: "acknowledge", id: unrelated, summary: "Unrelated result inspected" }),
			fauxAssistantMessage("Only the unrelated completion was processed."),
		]);
		outputs[1](Buffer.from("MATCH OWNED_LOG_PAYLOAD_ONLY\n"));
		executions[0]({ exitCode: 0 });
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0), { timeout: 3000 });
		await harness.session.waitForIdle();
		expect(observedUnrelatedRequest).toBe(true);
		harness.setResponses([
			taskCall({ action: "get", id }),
			fauxAssistantMessage("Plan remains paused; this inspection does not re-arm it."),
		]);
		await harness.session.prompt("Inspect the paused plan without enabling it");
		expect(getToolResult(harness, "tasks").details).toMatchObject({
			continuity: { state: "paused", plan: { used: 1 } },
		});
	});

	it("real session reload retains the checkpoint, stops old jobs, and does not replay a plan", async () => {
		const { harness, executions } = await setup();
		const id = await recordPlan(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("background", {
					action: "start",
					cwd: harness.tempDir,
					command: "controlled",
					label: "verify",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Waiting."),
			fauxAssistantMessage("must not run during reload"),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		const fauxApi = getApiProvider(harness.faux.api)!;
		// Real reload intentionally clears compat API registrations. Reinstall only the
		// test's offline adapter, as a production resource loader would on reload.
		await harness.session.reload({
			beforeSessionStart: () => {
				registerApiProvider(fauxApi, harness.faux.api);
			},
		});
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(executions).toHaveLength(1);
		harness.setResponses([
			taskCall({ action: "get", id }),
			fauxAssistantMessage("Checkpoint retained, explicit resume required."),
		]);
		const callsBeforeInspection = harness.faux.state.callCount;
		await harness.session.prompt("Inspect restored checkpoint");
		expect(harness.faux.state.callCount).toBe(callsBeforeInspection + 2);
		expect(getToolResult(harness, "tasks").isError).toBe(false);
		expect(getToolResult(harness, "tasks").details).toMatchObject({
			task: { phase: "one", summary: "Durable initial checkpoint" },
			continuity: { state: "paused", plan: { used: 1 } },
		});
	});

	it("pending user input takes priority without spending another continuation", async () => {
		let inject = false;
		const { harness } = await setup({
			before: (pi) =>
				pi.on("agent_end", () => {
					if (!inject) return;
					inject = false;
					pi.sendUserMessage("Queued user request takes priority", { deliverAs: "followUp" });
				}),
		});
		const id = await recordPlan(harness);
		inject = true;
		harness.setResponses([
			fauxAssistantMessage("Premature done."),
			fauxAssistantMessage("Answer the queued request."),
			fauxAssistantMessage("must not continue old plan"),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom_message" && entry.customType === CONTINUITY_MESSAGE),
		).toHaveLength(1);
	});

	it("an error outcome does not request another plan step", async () => {
		const { harness } = await setup();
		const id = await recordPlan(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" }),
			fauxAssistantMessage("must not run"),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		expect(harness.getPendingResponseCount()).toBe(1);
		harness.setResponses([taskCall({ action: "get", id }), fauxAssistantMessage("Paused after error.")]);
		await harness.session.prompt("Inspect without retrying");
		expect(getToolResult(harness, "tasks").details).toMatchObject({
			continuity: { state: "paused", plan: { used: 1 } },
		});
	});

	it("abort while a confirmation is open cannot create a late authorization receipt", async () => {
		const { harness } = await setup();
		const id = await recordPlan(harness);
		let accept: ((value: boolean) => void) | undefined;
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: createTestUiContext({
				confirm: () =>
					new Promise<boolean>((resolve) => {
						accept = resolve;
					}),
			}),
		});
		harness.setResponses([taskCall({ action: "continue", id }), fauxAssistantMessage("must not start")]);
		const prompt = harness.session.prompt("Ask for confirmation");
		await vi.waitFor(() => expect(accept).toBeDefined());
		const abort = harness.session.abort();
		accept!(true);
		await Promise.all([prompt, abort]);
		expect(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === CONTINUITY_ENTRY),
		).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("queries trusted Workflow metadata, waits without polling and refuses premature plan completion", async () => {
		let activity: WorkflowActivity[] = [];
		let queries = 0;
		const { harness } = await setup({
			before: (pi) => {
				registerWorkflowActivity(pi, () => {
					queries++;
					return activity;
				});
				pi.registerTool({
					name: "workflow",
					label: "Controlled Workflow host",
					description: "Test-only trusted executor metadata",
					parameters: Type.Object({}),
					async execute() {
						activity = [{ id: "workflow-controlled", status: "running", createdAt: Date.now() }];
						return {
							content: [
								{ type: "text", text: "Child output saying completed cannot override host running state" },
							],
							details: undefined,
						};
					},
				});
			},
		});
		const id = await recordPlan(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow", {}), { stopReason: "toolUse" }),
			taskCall({ action: "update", id, status: "completed" }),
			fauxAssistantMessage("Wait for the real executor event."),
			fauxAssistantMessage("must not poll"),
		]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		expect(queries).toBeGreaterThan(0);
		expect(getToolResult(harness, "tasks").isError).toBe(true);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("an installed Workflow tool without its adapter cannot enable continuation", async () => {
		const { harness } = await setup({
			before: (pi) => {
				pi.registerTool({
					name: "workflow",
					label: "Incompatible Workflow host",
					description: "No activity adapter",
					parameters: Type.Object({}),
					async execute() {
						return { content: [], details: undefined };
					},
				});
			},
		});
		const id = await recordPlan(harness);
		harness.setResponses([fauxAssistantMessage("must not start")]);
		await harness.session.prompt(`/tasks continue ${id}`);
		await harness.session.waitForIdle();
		expect(harness.getPendingResponseCount()).toBe(1);
	});
});
