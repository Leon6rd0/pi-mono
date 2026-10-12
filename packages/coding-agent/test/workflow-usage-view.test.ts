import { describe, expect, it } from "vitest";
import { type AgentRecord, emptyUsage, type WorkflowRecord } from "../examples/extensions/workflow/types.ts";
import {
	agentTokenLabel,
	workflowBacklogRows,
	workflowTokenLabel,
} from "../examples/extensions/workflow/usage-view.ts";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: "workflow-test/agent-1",
		role: "scout",
		label: "reader",
		phase: "Explore",
		status: "running",
		usage: emptyUsage(),
		requests: [],
		...overrides,
	};
}
function workflow(overrides: Partial<WorkflowRecord> = {}): WorkflowRecord {
	return {
		id: "workflow-test",
		label: "task",
		cwd: "/workspace",
		provider: "faux",
		model: "faux",
		status: "running",
		phase: "Explore",
		agents: [],
		usage: emptyUsage(),
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("Workflow usage presentation", () => {
	it("labels cumulative reported counts and separately exposes in-flight and unknown billing", () => {
		const record = workflow({
			usage: { ...emptyUsage(), totalTokens: 19599 },
			agents: [
				agent({
					requests: [
						{ id: "r1", status: "in_flight", source: "request_gate", startedAt: 1 },
						{ id: "r2", status: "unknown", source: "request_gate", startedAt: 1 },
					],
				}),
			],
		});
		expect(workflowTokenLabel(record)).toBe("19,599 tok reported · 1 in-flight · 1 unknown");
	});

	it("does not claim missing historical child usage is zero", () => {
		expect(agentTokenLabel(agent({ usage: undefined, requests: undefined }))).toBe("usage unavailable");
		expect(agentTokenLabel(agent())).toBe("0 tok reported");
	});

	it("puts token counts ahead of unbounded labels and displays the last request separately", () => {
		const record = workflow({
			label: "Long title ".repeat(30),
			usage: { ...emptyUsage(), totalTokens: 42 },
			agents: [
				agent({
					usage: { ...emptyUsage(), totalTokens: 42 },
					requests: [
						{ id: "r1", status: "reported", source: "request_gate", usage: { ...emptyUsage(), totalTokens: 42 } },
					],
				}),
			],
		});
		const rows = workflowBacklogRows([record]);
		expect(rows[0].startsWith("[running] 42 tok reported")).toBe(true);
		expect(rows[1]).toContain("42 tok reported · req 1 reported 42 tok");
	});

	it("never renders missing request usage as a completed zero-token request", () => {
		const rows = workflowBacklogRows([
			workflow({ agents: [agent({ requests: [{ id: "r1", status: "unknown", source: "request_gate" }] })] }),
		]);
		expect(rows[1]).toContain("1 unknown · req 1 unknown");
		expect(rows[1]).not.toContain("unknown 0 tok");
	});

	it("prioritizes older live workflows and displays all four running children", () => {
		const live = workflow({
			id: "old-live",
			agents: [
				...Array.from({ length: 4 }, (_, i) => agent({ label: `live-child-${i}` })),
				agent({ status: "queued", label: "queued-child" }),
			],
		});
		const records = [
			live,
			...Array.from({ length: 6 }, (_, i) =>
				workflow({ id: `ready-${i}`, status: "awaiting_result", agents: [agent({ status: "completed" })] }),
			),
		];
		const rows = workflowBacklogRows(records);
		expect(rows).toHaveLength(12); // Live workflow + 4 running children + queue count, then 3 recent results.
		for (let i = 0; i < 4; i++) expect(rows.join("\n")).toContain(`live-child-${i}`);
		expect(rows.join("\n")).toContain("1 queued · full request history");
		expect(rows.join("\n")).not.toContain("ready-0");
		expect(live.agents).toHaveLength(5);
	});

	it("displays an explicitly reported zero request as known zero", () => {
		const rows = workflowBacklogRows([
			workflow({
				agents: [
					agent({ requests: [{ id: "r1", status: "reported", source: "request_gate", usage: emptyUsage() }] }),
				],
			}),
		]);
		expect(rows[1]).toContain("req 1 reported 0 tok");
		expect(rows[1]).not.toContain("unknown");
	});

	it("removes terminal escape/control text from workflow and child labels", () => {
		const rows = workflowBacklogRows([
			workflow({ label: "bad\x1b[31m\x00\nlabel", agents: [agent({ label: "bad\x1b]52;c;evil\x07" })] }),
		]);
		expect(rows.join("\n")).not.toContain("\x1b");
		expect(rows[0]).not.toContain("\n");
	});
});
