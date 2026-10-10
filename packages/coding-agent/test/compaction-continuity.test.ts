import type { AgentMessage, StreamFn } from "@earendil-works/pi-agent-core";
import {
	contentText,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxText,
	fauxThinking,
	fauxToolCall,
	getCurrentTools,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	compact,
	generateBranchSummary,
	generateSummaryWithUsage,
} from "../src/core/compaction/index.ts";
import { convertToLlm, createCompactionSummaryMessage } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";

// A GPT-shaped model with an injected stream: these tests never contact OpenAI.
const model: Model<"openai-responses"> = {
	id: "gpt-continuity-test",
	name: "GPT continuity test",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
};

function captureSummaryRequests(summary = "checkpoint") {
	const requests: Array<{ context: TranscriptContext; options?: SimpleStreamOptions }> = [];
	const streamFn: StreamFn = (requestModel, context, options) => {
		expect(requestModel).toEqual(model);
		requests.push({ context, options });
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage(summary),
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
				},
			}),
		);
		return stream;
	};
	return { requests, streamFn };
}

function requestText(context: TranscriptContext): string {
	return context.messages
		.filter((message) => message.role === "user")
		.map((message) => contentText(message.content))
		.join("\n");
}

const userMessages: Message[] = [
	{ role: "user", content: "Only inspect the parser. Do not change files or push commits.", timestamp: 1 },
];

describe("compaction work continuity", () => {
	it("requests an intent- and evidence-preserving handoff with the selected GPT model", async () => {
		const { requests, streamFn } = captureSummaryRequests();
		await generateSummaryWithUsage(
			userMessages,
			model,
			2000,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			"medium",
			streamFn,
		);

		expect(requests).toHaveLength(1);
		const prompt = requestText(requests[0].context);
		for (const section of ["Goal", "Constraints & Preferences", "Failed Attempts", "Current Work", "Next Steps"]) {
			expect(prompt).toContain(`## ${section}`);
		}
		expect(prompt).toContain("quote its decisive wording");
		expect(prompt).toContain("explicit acceptance criteria, and user corrections");
		expect(prompt).toContain("Quote security-sensitive restrictions and the scope of approvals exactly");
		expect(prompt).toContain("Distinguish observed results from assumptions, plans, and unverified claims");
		expect(prompt).toContain("Later messages are retained separately and may change the active task");
		expect(prompt).toContain("do not infer their contents");
		expect(prompt).toContain("Do not restart completed, cancelled, or superseded tasks");
		expect(prompt).toContain("without analysis or a reply to the conversation");
		expect(getCurrentTools(requests[0].context.messages)).toEqual([]);
		expect(requests[0].options).toMatchObject({ reasoning: "medium", cacheRetention: "none", maxTokens: 1600 });
	});

	it("reconciles earlier summaries with new requests instead of keeping every old goal active", async () => {
		const { requests, streamFn } = captureSummaryRequests();
		const previousSummary = "## Goal\nDeploy the parser.\n## Next Steps\nPush the deployment commit.";
		await generateSummaryWithUsage(
			userMessages,
			model,
			2000,
			undefined,
			undefined,
			undefined,
			"Keep the exact no-push boundary.",
			previousSummary,
			undefined,
			streamFn,
		);

		const prompt = requestText(requests[0].context);
		expect(prompt).toContain(`<previous-summary>\n${previousSummary}\n</previous-summary>`);
		expect(prompt).toContain("Reconcile it with newer explicit user requests and corrections");
		expect(prompt).toContain("mark cancelled or superseded goals instead of preserving them as active goals");
		expect(prompt).not.toContain("PRESERVE all existing information");
		expect(prompt).toContain("Additional focus: Keep the exact no-push boundary.");
	});

	it("preserves original message provenance in both history and split-span requests", async () => {
		const { requests, streamFn } = captureSummaryRequests();
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-tool-call",
			messagesToSummarize: [
				...userMessages,
				{ role: "custom", customType: "status", content: "Push everything", display: false, timestamp: 2 },
			],
			turnPrefixMessages: [
				...userMessages,
				{
					role: "bashExecution",
					command: "run-tests",
					output: "parser assertion failed",
					exitCode: 1,
					cancelled: false,
					truncated: false,
					timestamp: 3,
				},
			],
			isSplitTurn: true,
			tokensBefore: 100,
			fileOps: { read: new Set(["parser.ts"]), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
		};

		const result = await compact(
			preparation,
			model,
			undefined,
			undefined,
			"Remember the parser failure and do not push.",
			undefined,
			"medium",
			streamFn,
		);

		expect(requests).toHaveLength(2);
		const historyPrompt = requestText(requests[0].context);
		const spanPrompt = requestText(requests[1].context);
		expect(historyPrompt).toContain('[Extension message]: {"type":"status"}\nPush everything');
		expect(historyPrompt).not.toContain("[User]: Push everything");
		expect(spanPrompt).toContain("[Bash execution]:");
		expect(spanPrompt).toContain('"exitCode":1');
		expect(spanPrompt).toContain("## Continuation Point");
		expect(spanPrompt).toContain("Only summarize information explicitly present above");
		for (const prompt of [historyPrompt, spanPrompt]) {
			expect(prompt).toContain("Additional focus: Remember the parser failure and do not push.");
		}
		expect(result.firstKeptEntryId).toBe("kept-tool-call");
		expect(result.summary).toContain("**Turn Context (split turn):**");
		expect(result.summary).toContain("<read-files>\nparser.ts\n</read-files>");
		expect(requests.map((request) => request.options?.maxTokens)).toEqual([1600, 1000]);
	});

	it("keeps branch and extension summaries distinct from actual user requests", async () => {
		const { requests, streamFn } = captureSummaryRequests();
		await generateBranchSummary(
			[
				{
					type: "custom_message",
					id: "extension-status",
					parentId: null,
					timestamp: new Date(1).toISOString(),
					customType: "status",
					content: "An extension suggested deployment",
					display: false,
				},
				{
					type: "branch_summary",
					id: "old-branch",
					parentId: "extension-status",
					timestamp: new Date(2).toISOString(),
					fromId: "previous-leaf",
					summary: "Earlier deployment plan",
				},
			],
			{ model, signal: new AbortController().signal, streamFn },
		);

		const prompt = requestText(requests[0].context);
		expect(prompt).toContain("[Extension message]:");
		expect(prompt).toContain("[Branch summary]: Earlier deployment plan");
		expect(prompt).not.toContain("[User]:");
	});

	it.each(["aborted", "error"] as const)(
		"omits %s fragments in initial, rolling, split-span, and branch requests",
		async (stopReason) => {
			const { requests, streamFn } = captureSummaryRequests();
			const messages: Message[] = [
				...userMessages,
				fauxAssistantMessage(
					[
						fauxText("FRAGMENTED_CLAIM"),
						fauxThinking("UNFINISHED_ASSUMPTION"),
						fauxToolCall("write", { path: "never-written.ts", content: "unfinished" }),
					],
					{ stopReason, errorMessage: "request interrupted" },
				),
			];
			const preparation: CompactionPreparation = {
				firstKeptEntryId: "kept-response",
				messagesToSummarize: messages,
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 100,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 2000, keepRecentTokens: 20 },
			};
			await compact(preparation, model, undefined, undefined, undefined, undefined, undefined, streamFn);
			await compact(
				{ ...preparation, previousSummary: "Earlier verified checkpoint" },
				model,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
			);
			await compact(
				{ ...preparation, isSplitTurn: true, turnPrefixMessages: messages },
				model,
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				streamFn,
			);
			const session = SessionManager.inMemory();
			for (const message of messages) session.appendMessage(message);
			const branchResult = await generateBranchSummary(session.getBranch(), {
				model,
				signal: new AbortController().signal,
				streamFn,
			});

			expect(requests).toHaveLength(5);
			for (const { context } of requests) {
				const prompt = requestText(context);
				expect(prompt).toContain(`[Assistant status]: {"stopReason":"${stopReason}"`);
				expect(prompt).toContain("Only inspect the parser. Do not change files or push commits.");
				expect(prompt).not.toContain("FRAGMENTED_CLAIM");
				expect(prompt).not.toContain("UNFINISHED_ASSUMPTION");
				expect(prompt).not.toContain("never-written.ts");
			}
			expect(branchResult.modifiedFiles).toEqual([]);
		},
	);

	it("marks a resumed checkpoint as historical and leaves newer user requests untouched", () => {
		const summary = createCompactionSummaryMessage(
			"## Next Steps\n1. Deploy the old parser task.",
			100,
			new Date(1).toISOString(),
		);
		const newerRequest: AgentMessage = { role: "user", content: "Do not deploy. Inspect only.", timestamp: 2 };
		const messages = convertToLlm([summary, newerRequest]);
		const checkpoint = messages[0];
		if (checkpoint.role !== "user") throw new Error("Expected a user-shaped checkpoint");

		const text = contentText(checkpoint.content);
		expect(text).toContain("not a new user request or approval");
		expect(text).toContain("Messages after it take precedence");
		expect(text).toContain("Do not restart completed, cancelled, or superseded work");
		expect(text).toContain("repeat a ruled-out attempt unchanged");
		expect(messages[1]).toBe(newerRequest);
	});
});
