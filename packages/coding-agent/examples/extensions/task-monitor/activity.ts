import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";

const channel = "task-monitor:workflow-activity-v1";
const notificationChannel = "task-monitor:workflow-notify-v1";
const schema = Type.Array(
	Type.Object({
		id: Type.String({ maxLength: 200 }),
		status: Type.Union([
			Type.Literal("running"),
			Type.Literal("paused"),
			Type.Literal("awaiting_result"),
			Type.Literal("archived"),
		]),
		outcome: Type.Optional(
			Type.Union([
				Type.Literal("completed"),
				Type.Literal("failed"),
				Type.Literal("stopped"),
				Type.Literal("unknown"),
			]),
		),
		createdAt: Type.Number(),
	}),
	{ maxItems: 1000 },
);

export interface WorkflowActivity {
	id: string;
	status: "running" | "paused" | "awaiting_result" | "archived";
	outcome?: "completed" | "failed" | "stopped" | "unknown";
	createdAt: number;
}

/** Trusted extensions cooperate through metadata only. Child output is never a state source. */
export function registerWorkflowActivity(pi: ExtensionAPI, list: () => WorkflowActivity[]): void {
	pi.events.on(channel, (request) => {
		if (
			typeof request !== "object" ||
			request === null ||
			!("report" in request) ||
			typeof request.report !== "function"
		)
			return;
		request.report(list().map(({ id, status, outcome, createdAt }) => ({ id, status, outcome, createdAt })));
	});
}

export function registerTaskNotificationGate(pi: ExtensionAPI, allow: (ids: string[]) => boolean): void {
	pi.events.on(notificationChannel, (request) => {
		if (
			typeof request !== "object" ||
			request === null ||
			!("ids" in request) ||
			!("report" in request) ||
			!Array.isArray(request.ids) ||
			request.ids.length > 50 ||
			!request.ids.every((id) => typeof id === "string" && id.length <= 200) ||
			typeof request.report !== "function"
		)
			return;
		let allowed = false;
		try {
			allowed = allow(request.ids);
		} catch {
			/* Accounting failure cannot authorize a model request. */
		}
		request.report(allowed);
	});
}

/** Old standalone Workflow installs retain normal notification behavior without a task monitor. */
export function allowWorkflowNotification(pi: ExtensionAPI, ids: string[]): boolean {
	if (ids.length > 50) return false;
	let responses = 0;
	let allowed = false;
	pi.events.emit(notificationChannel, {
		ids,
		report: (value: unknown) => {
			responses++;
			allowed = value === true;
		},
	});
	return responses === 0 || (responses === 1 && allowed);
}

/** Synchronous, fail closed if an installed Workflow tool has no compatible adapter. No polling. */
export function queryWorkflowActivity(pi: ExtensionAPI): WorkflowActivity[] | undefined {
	if (!pi.getAllTools().some((tool) => tool.name === "workflow")) return [];
	let responses = 0;
	let result: WorkflowActivity[] | undefined;
	pi.events.emit(channel, {
		report: (value: unknown) => {
			responses++;
			if (Check(schema, value)) result = structuredClone(value);
		},
	});
	return responses === 1 ? result : undefined;
}
