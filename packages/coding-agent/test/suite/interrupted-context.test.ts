import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { estimateContextTokens } from "../../src/core/compaction/index.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

describe("interrupted response context pipeline", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps real stream-abort history and executed tools, but omits unfinished output from requests and compaction", async () => {
		const writes = new Map<string, string>();
		const writeParameters = Type.Object({ path: Type.String(), content: Type.String() });
		const write: AgentTool<typeof writeParameters> = {
			name: "write",
			label: "Write",
			description: "Record a write in the test store",
			parameters: writeParameters,
			execute: async (_id, args) => {
				writes.set(args.path, args.content);
				return { content: [{ type: "text", text: `WRITE_DONE: ${args.path}` }], details: {} };
			},
		};
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 40, reserveTokens: 2000 } },
			tools: [write],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "executed.ts", content: "observed change" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				[
					fauxThinking("UNFINISHED_THINKING: speculative conclusion"),
					fauxToolCall("write", { path: "never-written.ts", content: "not executed" }),
					fauxText(`FRAGMENT: ${"unfinished answer ".repeat(1000)}`),
				],
				{ stopReason: "toolUse" },
			),
		]);

		// This is the same session cancellation API used by Escape, not a pre-labelled aborted fixture.
		let abort: Promise<void> | undefined;
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta" && !abort) {
				abort = harness.session.abort();
			}
		});
		await harness.session.prompt("Write executed.ts, then explain the result.");
		unsubscribe();
		await abort;

		const interrupted = harness.session.messages.find(
			(message) => message.role === "assistant" && message.stopReason === "aborted",
		);
		expect(interrupted).toBeDefined();
		expect(getMessageText(interrupted)).toContain("FRAGMENT:");
		expect(
			interrupted?.role === "assistant" &&
				interrupted.content.some(
					(block) => block.type === "toolCall" && block.arguments.path === "never-written.ts",
				),
		).toBe(true);
		expect(writes).toEqual(new Map([["executed.ts", "observed change"]]));
		expect(harness.session.getContextUsage()?.tokens).toBe(
			estimateContextTokens(harness.session.messages.filter((message) => message !== interrupted)).tokens,
		);

		const ordinaryRequests: string[] = [];
		const summaryRequests: string[] = [];
		harness.setResponses([
			(context) => {
				ordinaryRequests.push(context.messages.map(getMessageText).join("\n"));
				expect(
					context.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted"),
				).toBe(false);
				return fauxAssistantMessage("Verification complete. ".repeat(30));
			},
			(context) => {
				summaryRequests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("## Progress\n### Done\n- [x] executed.ts was written.\n## Next Steps\n(none)");
			},
			(context) => {
				summaryRequests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("## Original Request\nVerify only. Do not write any more files.");
			},
			(context) => {
				ordinaryRequests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("No further writes.");
			},
		]);

		await harness.session.prompt("Verify only. Do not write any more files.");
		await harness.session.compact();
		await harness.session.prompt("Continue verification only.");

		expect(ordinaryRequests).toHaveLength(2);
		expect(ordinaryRequests[0]).toContain("WRITE_DONE: executed.ts");
		expect(ordinaryRequests[0]).toContain("Verify only. Do not write any more files.");
		expect(summaryRequests).toHaveLength(2);
		expect(summaryRequests[0]).toContain('[Assistant status]: {"stopReason":"aborted"');
		expect(summaryRequests[0]).toContain("WRITE_DONE: executed.ts");
		expect(summaryRequests[1]).toContain("Verify only. Do not write any more files.");
		for (const request of [...ordinaryRequests, ...summaryRequests]) {
			expect(request).not.toContain("FRAGMENT:");
			expect(request).not.toContain("UNFINISHED_THINKING");
			expect(request).not.toContain("never-written.ts");
		}
		const compaction = harness.sessionManager.getBranch().find((entry) => entry.type === "compaction");
		expect(compaction?.details).toEqual({ readFiles: [], modifiedFiles: ["executed.ts"] });
		const persisted = harness.sessionManager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "aborted",
			);
		expect(persisted?.type === "message" && persisted.message).toEqual(interrupted);
		expect(writes.size).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
