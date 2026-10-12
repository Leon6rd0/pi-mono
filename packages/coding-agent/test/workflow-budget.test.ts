import type { Usage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	BudgetAdmissionError,
	type RequestBudgetEstimate,
	WorkflowBudgetLedger,
} from "../examples/extensions/workflow/budget.ts";
import { emptyUsage } from "../examples/extensions/workflow/types.ts";

function estimate(id: string, overrides: Partial<RequestBudgetEstimate> = {}): RequestBudgetEstimate {
	return {
		id,
		agentId: "agent-a",
		phaseId: "phase-a",
		estimatedInputTokens: 100,
		maxOutputTokens: 50,
		marginTokens: 10,
		...overrides,
	};
}
function usage(tokens: number, overrides: Partial<Usage> = {}): Usage {
	return { ...emptyUsage(), input: tokens, totalTokens: tokens, ...overrides };
}
function sent(ledger: WorkflowBudgetLedger, id: string, overrides: Partial<RequestBudgetEstimate> = {}) {
	ledger.reserve(estimate(id, overrides));
	ledger.markDispatched(id);
}

describe("Workflow request budget ledger", () => {
	it("reserves input, bounded output and margin, without altering reported usage", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		expect(ledger.reserve(estimate("r1"))).toMatchObject({ reservedTokens: 160, status: "reserved" });
		expect(ledger.snapshot()).toMatchObject({
			availableTokens: 840,
			reservedTokens: 160,
			unknownTokens: 0,
			usage: { totalTokens: 0 },
		});
	});

	it("atomically admits only affordable competing callbacks", async () => {
		const ledger = new WorkflowBudgetLedger(400);
		const results = await Promise.allSettled(["r1", "r2", "r3"].map(async (id) => ledger.reserve(estimate(id))));
		expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled", "rejected"]);
		expect(ledger.snapshot()).toMatchObject({ availableTokens: 80, reservedTokens: 320 });
		expect(ledger.snapshot().requests).toHaveLength(2);
	});

	it("reports the blocked scope and leaves failed admission side-effect free", () => {
		const ledger = new WorkflowBudgetLedger(300);
		ledger.reserve(estimate("r1"));
		const before = ledger.snapshot();
		try {
			ledger.reserve(estimate("r2"));
			throw new Error("Expected admission failure");
		} catch (error) {
			expect(error).toBeInstanceOf(BudgetAdmissionError);
			expect(error).toMatchObject({ scope: "workflow", requestedTokens: 160, availableTokens: 140 });
		}
		expect(ledger.snapshot()).toEqual(before);
	});

	it("settles once and returns an overestimated difference to the balance", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		sent(ledger, "r1");
		expect(ledger.settle("r1", usage(120))).toEqual({ applied: true, unknown: false, exceeded: [] });
		expect(ledger.snapshot()).toMatchObject({ availableTokens: 880, reservedTokens: 0, usage: { totalTokens: 120 } });
		expect(ledger.settle("r1", usage(120))).toEqual({ applied: false, unknown: false, exceeded: [] });
		expect(ledger.snapshot().usage.totalTokens).toBe(120);
		expect(() => ledger.settle("r1", usage(121))).toThrow("Conflicting usage");
		expect(ledger.snapshot().usage.totalTokens).toBe(120);
	});

	it("records actual underestimation/overshoot without falsely capping the bill", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		sent(ledger, "r1");
		expect(ledger.settle("r1", usage(1200))).toEqual({
			applied: true,
			unknown: false,
			exceeded: ["workflow", "agent", "phase"],
		});
		expect(ledger.snapshot()).toMatchObject({
			usage: { totalTokens: 1200 },
			reservedTokens: 0,
			availableTokens: 0,
			overspentTokens: 200,
		});
		expect(() => ledger.reserve(estimate("r2"))).toThrow(BudgetAdmissionError);
	});

	it("treats exactly reaching a limit as a boundary, without inventing overspend", () => {
		const ledger = new WorkflowBudgetLedger(200);
		sent(ledger, "r1");
		expect(ledger.settle("r1", usage(200)).exceeded).toContain("workflow");
		expect(ledger.snapshot()).toMatchObject({ availableTokens: 0, overspentTokens: 0 });
	});

	it("keeps sent unknown usage reserved and distinguishes it from zero reported spend", () => {
		const ledger = new WorkflowBudgetLedger(200);
		sent(ledger, "r1");
		expect(ledger.settle("r1", emptyUsage())).toEqual({ applied: false, unknown: true, exceeded: [] });
		expect(ledger.snapshot()).toMatchObject({
			reservedTokens: 160,
			unknownTokens: 160,
			availableTokens: 40,
			usage: { totalTokens: 0 },
		});
		expect(ledger.markUnknown("r1")).toBe(false);
		expect(() => ledger.reserve(estimate("r2"))).toThrow(BudgetAdmissionError);
		expect(() => ledger.releaseUnsent("r1")).toThrow("potentially dispatched");
	});

	it("settles explicitly confirmed zero reports without confusing missing metrics with free usage", () => {
		const ledger = new WorkflowBudgetLedger(200);
		sent(ledger, "r1");
		ledger.markUnknown("r1");
		expect(ledger.settle("r1", emptyUsage(), { reported: true })).toEqual({
			applied: true,
			unknown: false,
			exceeded: [],
		});
		expect(ledger.snapshot()).toMatchObject({ reservedTokens: 0, unknownTokens: 0, availableTokens: 200 });
		expect(ledger.settle("r1", emptyUsage(), { reported: true }).applied).toBe(false);
	});

	it("bounds separately defined agent/phase scopes, even when they have no requests", () => {
		const ledger = new WorkflowBudgetLedger(1000, 1);
		ledger.defineScope("agent", "agent-a", 200);
		ledger.defineScope("phase", "phase-a", 200);
		expect(() => ledger.defineScope("agent", "agent-b", 200)).toThrow("scope record limit");
		expect(() => ledger.defineScope("phase", "phase-b", 200)).toThrow("scope record limit");
	});

	it("accepts late trustworthy usage for an unknown request without double charging", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		sent(ledger, "r1");
		ledger.markUnknown("r1");
		ledger.settle("r1", usage(80));
		expect(ledger.snapshot()).toMatchObject({
			reservedTokens: 0,
			unknownTokens: 0,
			availableTokens: 920,
			usage: { totalTokens: 80 },
		});
		expect(ledger.settle("r1", usage(80)).applied).toBe(false);
	});

	it("releases confirmed unsent requests only and cannot reuse an old request ID", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		ledger.reserve(estimate("unsent"));
		expect(ledger.releaseUnsent("unsent")).toBe(true);
		expect(ledger.releaseUnsent("unsent")).toBe(false);
		expect(ledger.snapshot()).toMatchObject({ reservedTokens: 0, availableTokens: 1000 });
		expect(() => ledger.reserve(estimate("unsent"))).toThrow("already used");
		expect(() => ledger.markDispatched("unsent")).toThrow("terminated");
		expect(() => ledger.settle("unsent", usage(20))).toThrow("undispatched");
	});

	it("does not refund an in-flight or settled request and does not redispatch unknown work", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		sent(ledger, "r1");
		ledger.markDispatched("r1");
		expect(() => ledger.releaseUnsent("r1")).toThrow("potentially dispatched");
		ledger.markUnknown("r1");
		expect(() => ledger.markDispatched("r1")).toThrow("unknown");
		ledger.settle("r1", usage(100));
		expect(() => ledger.releaseUnsent("r1")).toThrow("potentially dispatched");
		expect(() => ledger.markUnknown("r1")).toThrow("Only a dispatched");
	});

	it("keeps phase/agent ownership fixed for late settlement", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		sent(ledger, "r1");
		sent(ledger, "r2", { agentId: "agent-b", phaseId: "phase-b" });
		ledger.settle("r2", usage(100));
		ledger.settle("r1", usage(90));
		const snapshot = ledger.snapshot();
		expect(snapshot.usage.totalTokens).toBe(190);
		expect(snapshot.agents.map((scope) => [scope.id, scope.usage.totalTokens])).toEqual([
			["agent-a", 90],
			["agent-b", 100],
		]);
		expect(snapshot.phases.map((scope) => [scope.id, scope.usage.totalTokens])).toEqual([
			["phase-a", 90],
			["phase-b", 100],
		]);
	});

	it("applies child budgets without hiding the global available balance", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		ledger.defineScope("agent", "agent-a", 200);
		sent(ledger, "r1");
		ledger.settle("r1", usage(120));
		expect(() => ledger.reserve(estimate("r2"))).toThrow(
			expect.objectContaining({ scope: "agent", availableTokens: 80 }),
		);
		ledger.reserve(estimate("r3", { agentId: "agent-b" }));
		expect(ledger.snapshot().reservedTokens).toBe(160);
	});

	it("applies shared phase budgets across different children", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		ledger.defineScope("phase", "phase-a", 300);
		ledger.reserve(estimate("r1"));
		expect(() => ledger.reserve(estimate("r2", { agentId: "agent-b" }))).toThrow(
			expect.objectContaining({ scope: "phase", availableTokens: 140 }),
		);
		expect(ledger.snapshot().requests).toHaveLength(1);
	});

	it("cannot increase or redefine scope budgets after use", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		expect(() => ledger.defineScope("agent", "agent-a", 1001)).toThrow("exceeds workflow");
		ledger.defineScope("agent", "agent-a", 200);
		expect(() => ledger.defineScope("agent", "agent-a", 300)).toThrow("already defined");
		ledger.reserve(estimate("r1"));
		expect(() => ledger.defineScope("phase", "phase-a", 300)).toThrow("used");
	});

	it("counts cached input and prevents understated native totals", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		sent(ledger, "r1");
		ledger.settle("r1", usage(10, { output: 5, cacheRead: 100, cacheWrite: 20, totalTokens: 1 }));
		expect(ledger.snapshot().usage).toMatchObject({
			input: 10,
			output: 5,
			cacheRead: 100,
			cacheWrite: 20,
			totalTokens: 135,
		});
		expect(ledger.snapshot().availableTokens).toBe(865);
	});

	it("accepts a reported total larger than known components rather than losing billing evidence", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		sent(ledger, "r1");
		ledger.settle("r1", usage(20, { totalTokens: 100 }));
		expect(ledger.snapshot().usage.totalTokens).toBe(100);
	});

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid input estimate %s before reserving",
		(value) => {
			const ledger = new WorkflowBudgetLedger(1000);
			expect(() => ledger.reserve(estimate("r1", { estimatedInputTokens: value }))).toThrow("safe integer");
			expect(ledger.snapshot().requests).toEqual([]);
		},
	);

	it("rejects invalid usage without releasing the existing debit", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		sent(ledger, "r1");
		expect(() => ledger.settle("r1", usage(-1))).toThrow("usage.input");
		expect(() => ledger.settle("r1", usage(10, { cost: { ...emptyUsage().cost, total: Number.NaN } }))).toThrow(
			"cost.total",
		);
		expect(ledger.snapshot()).toMatchObject({ reservedTokens: 160, availableTokens: 840, usage: { totalTokens: 0 } });
	});

	it("bounds request records, including released records, and rejects unknown IDs", () => {
		const ledger = new WorkflowBudgetLedger(1000, 1);
		ledger.reserve(estimate("r1"));
		ledger.releaseUnsent("r1");
		expect(() => ledger.reserve(estimate("r2"))).toThrow("record limit");
		expect(() => ledger.markDispatched("missing")).toThrow("Unknown budget");
	});

	it("returns isolated snapshots and admission records that cannot alter ownership or balances", () => {
		const ledger = new WorkflowBudgetLedger(1000);
		const reserved = ledger.reserve(estimate("r1"));
		reserved.agentId = "other";
		reserved.reservedTokens = 0;
		reserved.status = "released";
		ledger.markDispatched("r1");
		ledger.settle("r1", usage(120));
		const snapshot = ledger.snapshot();
		snapshot.usage.totalTokens = 0;
		snapshot.requests[0].usage!.totalTokens = 0;
		expect(ledger.snapshot()).toMatchObject({
			usage: { totalTokens: 120 },
			requests: [{ agentId: "agent-a", status: "settled", usage: { totalTokens: 120 } }],
		});
	});

	it.each([0, -1, 0.5, Number.NaN, 2000001])("rejects invalid workflow limit %s", (limit) => {
		expect(() => new WorkflowBudgetLedger(limit)).toThrow();
	});
});
