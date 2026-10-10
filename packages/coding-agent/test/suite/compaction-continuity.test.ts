import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getMessageText, getUserTexts, type Harness } from "./harness.ts";

describe("compaction continuation pipeline", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps a newer change of scope ahead of a stale historical next step after manual compaction", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, keepRecentTokens: 40, reserveTokens: 2000 } },
		});
		harnesses.push(harness);
		const currentRequest = "Parser work is complete. Only inspect compact now. Do not edit files or push commits.";
		let summaryRequest = "";
		let resumedUserTexts: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("Parser completed and tested. ".repeat(20)),
			fauxAssistantMessage("Inspection started."),
			(context) => {
				summaryRequest = context.messages.map(getMessageText).join("\n");
				expect(getCurrentTools(context.messages)).toEqual([]);
				return fauxAssistantMessage("## Goal\nOld parser task\n## Next Steps\n1. Resume parser edits.");
			},
			(context) => {
				resumedUserTexts = context.messages.filter((message) => message.role === "user").map(getMessageText);
				return fauxAssistantMessage("Continuing only the compact inspection.");
			},
		]);

		await harness.session.prompt("Fix the parser. Do not deploy.");
		await harness.session.prompt(currentRequest);
		await harness.session.compact("Preserve permission boundaries.");

		// The summarizer only sees the earlier span, so it must not invent the retained span's state.
		expect(summaryRequest).not.toContain(currentRequest);
		expect(summaryRequest).toContain("Later messages are retained separately and may change the active task");
		expect(summaryRequest).toContain("Additional focus: Preserve permission boundaries.");
		expect(getUserTexts(harness)).toContain(currentRequest);

		await harness.session.prompt("Continue the inspection.");

		const checkpointIndex = resumedUserTexts.findIndex((text) => text.includes("<summary>"));
		expect(checkpointIndex).toBeGreaterThanOrEqual(0);
		expect(resumedUserTexts[checkpointIndex]).toContain("Messages after it take precedence");
		expect(resumedUserTexts[checkpointIndex]).toContain("not a new user request or approval");
		expect(resumedUserTexts.indexOf(currentRequest)).toBeGreaterThan(checkpointIndex);
		expect(resumedUserTexts.at(-1)).toBe("Continue the inspection.");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("uses the same handoff rules for threshold compaction between tool execution and the next response", async () => {
		const largeTool: AgentTool = {
			name: "large_result",
			label: "Large result",
			description: "Return enough output to cross the context threshold",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(8000)}` }],
				details: {},
			}),
		};
		const harness = await createHarness({
			// Keep the threshold at 2200 tokens, with enough headroom for the retained tool result and checkpoint.
			models: [{ id: "faux-continuity", contextWindow: 4000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 1800, keepRecentTokens: 1750 } },
			tools: [largeTool],
		});
		harnesses.push(harness);
		const summaryRequests: string[] = [];
		let resumedRequest = "";
		harness.setResponses([
			fauxAssistantMessage(`old-history:${"a".repeat(800)}`),
			fauxAssistantMessage(`recent-history:${"b".repeat(800)}`),
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				summaryRequests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("## Goal\nInspect output only.\n## Failed Attempts\n(none)");
			},
			(context) => {
				summaryRequests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage(
					"## Original Request\nInspect output only.\n## Continuation Point\nTool pending.",
				);
			},
			(context) => {
				resumedRequest = context.messages.map(getMessageText).join("\n");
				// Keep the final response newer than the checkpoint, even within one clock millisecond.
				return fauxAssistantMessage("Output inspection complete.", { timestamp: Date.now() + 1000 });
			},
			(context) => {
				// The oversized retained result also crosses the post-run threshold; compact it once completed.
				summaryRequests.push(context.messages.map(getMessageText).join("\n"));
				return fauxAssistantMessage("## Progress\n### Done\n- [x] Output inspected.\n## Next Steps\n(none)");
			},
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("Inspect the output only. Do not modify any files.");

		expect(summaryRequests).toHaveLength(3);
		expect(summaryRequests[2]).toContain("<previous-summary>");
		expect(summaryRequests[2]).toContain("Replace stale current-work and next-step entries");
		for (const request of summaryRequests) {
			expect(request).toContain("Only actual user messages establish user requests or approvals");
			expect(request).toContain("Distinguish observed results from assumptions, plans, and unverified claims");
		}
		expect(summaryRequests[1]).toContain("## Continuation Point");
		expect(summaryRequests[1]).toContain("Inspect the output only. Do not modify any files.");
		expect(resumedRequest).toContain("not a new user request or approval");
		expect(resumedRequest).toContain("large-tool-result:");
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
		});
		expect(harness.eventsOfType("compaction_end").filter((event) => event.errorMessage)).toEqual([]);
		expect(harness.session.getLastAssistantText()).toBe("Output inspection complete.");
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
