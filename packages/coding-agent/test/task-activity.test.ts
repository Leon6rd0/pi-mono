import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	allowWorkflowNotification,
	queryWorkflowActivity,
	registerTaskNotificationGate,
	registerWorkflowActivity,
	type WorkflowActivity,
} from "../examples/extensions/task-monitor/activity.ts";
import { createEventBus } from "../src/core/event-bus.ts";

// Only these two host API methods are used by the metadata protocol.
function host(workflow = true): ExtensionAPI {
	return {
		events: createEventBus(),
		getAllTools: () => (workflow ? [{ name: "workflow" }] : []),
	} as unknown as ExtensionAPI;
}

describe("task/Workflow metadata and notification adapter", () => {
	it("distinguishes no Workflow tool from an unavailable activity adapter", () => {
		expect(queryWorkflowActivity(host(false))).toEqual([]);
		expect(queryWorkflowActivity(host())).toBeUndefined();
	});
	it("copies only validated host metadata, without model output or shared mutable objects", () => {
		const pi = host();
		const records: WorkflowActivity[] = [{ id: "workflow-owned", createdAt: 1, status: "running" }];
		registerWorkflowActivity(pi, () => records);
		const result = queryWorkflowActivity(pi)!;
		expect(result).toEqual(records);
		result[0].status = "archived";
		expect(records[0].status).toBe("running");
	});
	it("rejects invalid and duplicate activity responses", () => {
		const invalid = host();
		registerWorkflowActivity(invalid, () => [
			{ id: "workflow", createdAt: 1, status: "invented-success" } as unknown as WorkflowActivity,
		]);
		expect(queryWorkflowActivity(invalid)).toBeUndefined();
		const duplicate = host();
		registerWorkflowActivity(duplicate, () => []);
		registerWorkflowActivity(duplicate, () => []);
		expect(queryWorkflowActivity(duplicate)).toBeUndefined();
	});
	it("keeps standalone event behavior, but obeys an installed continuation gate", () => {
		const pi = host();
		expect(allowWorkflowNotification(pi, ["workflow-a"])).toBe(true);
		registerTaskNotificationGate(pi, () => false);
		expect(allowWorkflowNotification(pi, ["workflow-a"])).toBe(false);
	});
	it("fails closed on accounting exceptions and duplicate gate responses", () => {
		const throwing = host();
		registerTaskNotificationGate(throwing, () => {
			throw new Error("storage unavailable");
		});
		expect(allowWorkflowNotification(throwing, ["workflow-a"])).toBe(false);
		const duplicate = host();
		registerTaskNotificationGate(duplicate, () => true);
		registerTaskNotificationGate(duplicate, () => true);
		expect(allowWorkflowNotification(duplicate, ["workflow-a"])).toBe(false);
	});
});
