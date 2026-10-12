import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { safeText } from "../task-monitor/manager.ts";
import type { ChildProgress, ToolProgress } from "./types.ts";

function excerpt(text: string, limit: number): { text: string; truncated: boolean } {
	const clean = safeText(text);
	if (clean.length <= limit) return { text: clean, truncated: false };
	const head = Math.floor((limit - 30) / 2);
	return { text: `${clean.slice(0, head)}\n[...partial excerpt...]\n${clean.slice(-head)}`, truncated: true };
}

function toolText(result: unknown): string {
	if (typeof result !== "object" || result === null) return "";
	const content = (result as Record<string, unknown>).content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: unknown) => {
			if (typeof part !== "object" || part === null) return [];
			const block = part as Record<string, unknown>;
			return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
		})
		.join("\n");
}

/** Bounded execution observations, never a verified facts summary or a resume authority. */
export class ChildProgressTracker {
	private output = "";
	private outputTruncated = false;
	private readonly operations: ToolProgress[] = [];
	private droppedOperations = 0;

	observe(event: AgentEvent): boolean {
		if (event.type === "message_end" && event.message.role === "assistant") {
			const text = event.message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (!text) return false; // A synthetic empty error must not erase already-retained notes.
			const retained = excerpt(text, 8192);
			this.output = retained.text;
			this.outputTruncated = retained.truncated;
			return true;
		}
		if (event.type === "tool_execution_start") {
			if (this.operations.length >= 64) {
				this.operations.shift();
				this.droppedOperations++;
			}
			const args =
				typeof event.args === "object" && event.args !== null ? (event.args as Record<string, unknown>) : {};
			this.operations.push({
				id: event.toolCallId.slice(0, 200),
				name: event.toolName.slice(0, 200),
				...(typeof args.path === "string" ? { path: safeText(args.path).slice(0, 512) } : {}),
				mutation: event.toolName === "edit" || event.toolName === "write",
				status: "started",
			});
			return true;
		}
		if (event.type === "tool_execution_end") {
			const operation = this.operations.findLast((item) => item.id === event.toolCallId.slice(0, 200));
			if (!operation) return false;
			operation.status = event.isError ? "failed" : "completed";
			const result = excerpt(toolText(event.result), 2000);
			operation.result = result.text;
			operation.truncated = result.truncated;
			return true;
		}
		return false;
	}

	/** Failure/abort does not prove an in-progress mutation left files unchanged. */
	interrupt(): boolean {
		let changed = false;
		for (const operation of this.operations)
			if (operation.status === "started") {
				operation.status = "unknown";
				changed = true;
			}
		return changed;
	}

	snapshot(): ChildProgress {
		return {
			partial: true,
			output: this.output,
			outputTruncated: this.outputTruncated,
			operations: structuredClone(this.operations),
			droppedOperations: this.droppedOperations,
			updatedAt: Date.now(),
		};
	}
}
