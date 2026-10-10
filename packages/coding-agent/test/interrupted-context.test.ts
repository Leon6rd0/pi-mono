import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	prepareCompaction,
} from "../src/core/compaction/index.ts";
import { computeFileLists, createFileOps, extractFileOpsFromMessage } from "../src/core/compaction/utils.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const interruptedReasons = ["aborted", "error"] as const;

function incompleteMessage(stopReason: (typeof interruptedReasons)[number]) {
	return fauxAssistantMessage(
		[
			fauxText("unfinished-answer".repeat(1000)),
			fauxThinking("unfinished-thinking".repeat(1000)),
			fauxToolCall("write", { path: "never-written.ts", content: "unfinished-content".repeat(1000) }),
		],
		{ stopReason, errorMessage: "request interrupted" },
	);
}

describe("interrupted assistant context", () => {
	it.each(interruptedReasons)(
		"excludes %s output from provider-independent conversion without changing history",
		(reason) => {
			const user: AgentMessage = { role: "user", content: "Inspect only. Do not write files.", timestamp: 1 };
			const call = fauxToolCall("read", { path: "actual.ts" });
			const completed = fauxAssistantMessage(call, { stopReason: "toolUse" });
			const result: AgentMessage = {
				role: "toolResult",
				toolCallId: call.id,
				toolName: "read",
				content: [{ type: "text", text: "observed file content" }],
				isError: false,
				timestamp: 2,
			};
			const interrupted = incompleteMessage(reason);
			const history = [user, completed, result, interrupted];
			const original = structuredClone(history);

			const modelMessages = convertToLlm(history);
			expect(modelMessages).toHaveLength(3);
			expect(modelMessages).toEqual([user, completed, result]);
			expect(history).toEqual(original);
		},
	);

	it.each(interruptedReasons)("does not count %s output with or without an earlier usage anchor", (reason) => {
		const user: AgentMessage = { role: "user", content: "inspect", timestamp: 1 };
		const interrupted = incompleteMessage(reason);
		expect(estimateTokens(interrupted)).toBe(0);
		expect(estimateContextTokens([user, interrupted])).toEqual(estimateContextTokens([user]));

		const completed = fauxAssistantMessage("observed result");
		completed.usage = { ...completed.usage, input: 100, output: 50, totalTokens: 150 };
		expect(estimateContextTokens([completed, user, interrupted])).toEqual(estimateContextTokens([completed, user]));
	});

	it.each(interruptedReasons)("does not let %s output move the retained boundary past executed tools", (reason) => {
		const session = SessionManager.inMemory();
		session.appendMessage({ role: "user", content: "old request", timestamp: 1 });
		session.appendMessage(fauxAssistantMessage("old result"));
		session.appendMessage({ role: "user", content: "read actual.ts", timestamp: 2 });
		const call = fauxToolCall("read", { path: "actual.ts" });
		const callId = session.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }));
		session.appendMessage({
			role: "toolResult",
			toolCallId: call.id,
			toolName: "read",
			content: [{ type: "text", text: "actual output".repeat(1000) }],
			isError: false,
			timestamp: 3,
		});
		session.appendMessage(incompleteMessage(reason));
		const entries = session.getBranch();

		expect(findCutPoint(entries, 0, entries.length, 1000).firstKeptEntryIndex).toBe(3);
		const preparation = prepareCompaction(entries, { ...DEFAULT_COMPACTION_SETTINGS, keepRecentTokens: 1000 });
		expect(preparation?.firstKeptEntryId).toBe(callId);
	});

	it.each(interruptedReasons)("does not record unexecuted %s calls as file modifications", (reason) => {
		const fileOps = createFileOps();
		extractFileOpsFromMessage(incompleteMessage(reason), fileOps);
		// A cancelled codemode script may already have changed a file before cancellation.
		extractFileOpsFromMessage(
			{
				role: "toolResult",
				toolCallId: "executed-script",
				toolName: "codemode",
				content: [{ type: "text", text: "script cancelled after writing actual.ts" }],
				isError: true,
				timestamp: 1,
				nestedCalls: {
					calls: [{ id: "executed-script/1", name: "write", arguments: { path: "actual.ts" }, status: "ok" }],
					complete: false,
				},
			},
			fileOps,
		);

		expect(computeFileLists(fileOps)).toEqual({ readFiles: [], modifiedFiles: ["actual.ts"] });
	});

	it("leaves length-stop recovery to its existing policy", () => {
		const message = fauxAssistantMessage("token-limited output", { stopReason: "length" });
		expect(convertToLlm([message])).toEqual([message]);
		expect(estimateTokens(message)).toBeGreaterThan(0);
	});
});
