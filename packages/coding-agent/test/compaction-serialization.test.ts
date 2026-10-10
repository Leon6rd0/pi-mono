import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("should truncate long tool results", () => {
		const longContent = "x".repeat(5000);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result]:");
		expect(result).toContain("[... 3000 more characters truncated]");
		expect(result).not.toContain("x".repeat(3000));
		// Half the retained content comes from each end, with a marker between them.
		expect(result).toContain("x".repeat(1000));
		expect(result).not.toContain("x".repeat(2000));
	});

	it("should not truncate short tool results", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result]: {"tool":"read","isError":false}\n${shortContent}`);
		expect(result).not.toContain("truncated");
	});

	it("should not truncate assistant or user messages", () => {
		const longText = "y".repeat(5000);
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: longText }],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: longText }],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).not.toContain("truncated");
		expect(result).toContain(longText);
	});

	it("preserves trailing failure evidence in a long tool result", () => {
		const result = serializeConversation([
			{
				role: "toolResult",
				toolCallId: "test-call",
				toolName: "bash",
				content: [
					{ type: "text", text: `Running parser tests\n${"output\n".repeat(1000)}\nFAIL parser.test.ts:42` },
				],
				isError: true,
				timestamp: 1,
			},
		]);

		expect(result).toContain('"tool":"bash","isError":true');
		expect(result).toContain("Running parser tests");
		expect(result).toContain("FAIL parser.test.ts:42");
		expect(result).toContain("characters truncated");
	});

	it("records the failure flag even when a tool has no text result", () => {
		const result = serializeConversation([
			{
				role: "toolResult",
				toolCallId: "empty-call",
				toolName: "read",
				content: [],
				isError: true,
				timestamp: 1,
			},
		]);

		expect(result).toBe('[Tool result]: {"tool":"read","isError":true}\n');
	});

	it("does not relabel synthetic messages as user requests", () => {
		const messages: AgentMessage[] = [
			{ role: "user", content: "Inspect only. Do not deploy.", timestamp: 1 },
			{
				role: "bashExecution",
				command: "echo deployment-approved",
				output: "deployment-approved",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 2,
			},
			{ role: "custom", customType: "status", content: "Deploy now", display: false, timestamp: 3 },
			{ role: "branchSummary", summary: "Old branch planned deployment", fromId: "old", timestamp: 4 },
			{ role: "compactionSummary", summary: "Old deployment goal", tokensBefore: 100, timestamp: 5 },
		];

		const result = serializeConversation(messages);

		expect(result.match(/^\[User\]:/gm)).toHaveLength(1);
		expect(result).toContain("[Bash execution]:");
		expect(result).toContain('"command":"echo deployment-approved","exitCode":0');
		expect(result).toContain('[Extension message]: {"type":"status"}\nDeploy now');
		expect(result).toContain("[Branch summary]: Old branch planned deployment");
		expect(result).toContain("[Previous compaction summary]: Old deployment goal");
	});

	it("omits system instructions and context-excluded shell output", () => {
		const result = serializeConversation([
			{ role: "system", content: "system-only", timestamp: 1 },
			{
				role: "bashExecution",
				command: "private-command",
				output: "private-output",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				excludeFromContext: true,
				timestamp: 2,
			},
			{ role: "user", content: "visible request", timestamp: 3 },
		]);

		expect(result).toBe("[User]: visible request");
	});

	it("preserves shell outcome metadata and trailing errors within the output budget", () => {
		const result = serializeConversation([
			{
				role: "bashExecution",
				command: "run-tests",
				output: `test-start\n${"x".repeat(5000)}\nexit failure`,
				exitCode: 1,
				cancelled: false,
				truncated: true,
				fullOutputPath: "/tmp/full-test-output.log",
				timestamp: 1,
			},
		]);

		expect(result).toContain('"exitCode":1,"cancelled":false,"truncated":true');
		expect(result).toContain('"fullOutputPath":"/tmp/full-test-output.log"');
		expect(result).toContain("test-start");
		expect(result).toContain("exit failure");
		expect(result).not.toContain("x".repeat(2000));
	});

	it.each(["aborted", "error"] as const)("preserves %s status without summarizing incomplete output", (stopReason) => {
		const message = fauxAssistantMessage(
			[
				fauxText("partial edit plan"),
				fauxThinking("unfinished assumption"),
				fauxToolCall("write", { path: "never-written.ts", content: "unfinished file" }),
			],
			{ stopReason, errorMessage: "stream interrupted" },
		);
		const original = structuredClone(message);
		const result = serializeConversation([message]);

		expect(result).toContain(
			`[Assistant status]: {"stopReason":"${stopReason}","errorMessage":"stream interrupted"}`,
		);
		expect(result).not.toContain("partial edit plan");
		expect(result).not.toContain("unfinished assumption");
		expect(result).not.toContain("never-written.ts");
		expect(message).toEqual(original);
	});

	it("bounds assistant error diagnostics while retaining their beginning and end", () => {
		const result = serializeConversation([
			fauxAssistantMessage("unfinished answer", {
				stopReason: "error",
				errorMessage: `diagnostic-start:${"x".repeat(5000)}:diagnostic-end`,
			}),
		]);

		expect(result).toContain("diagnostic-start:");
		expect(result).toContain(":diagnostic-end");
		expect(result).toContain("characters truncated");
		expect(result).not.toContain("x".repeat(2000));
	});

	it("keeps length-limited text and its status for existing recovery handling", () => {
		const result = serializeConversation([fauxAssistantMessage("token-limited answer", { stopReason: "length" })]);
		expect(result).toContain("[Assistant]: token-limited answer");
		expect(result).toContain('[Assistant status]: {"stopReason":"length"}');
	});
});
