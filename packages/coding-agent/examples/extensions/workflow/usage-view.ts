import { safeText } from "../task-monitor/manager.ts";
import type { BudgetTotals } from "./budget.ts";
import type { AgentRecord, ModelRequestRecord, WorkflowRecord } from "./types.ts";

const count = (value: number) => value.toLocaleString("en-US");

function requestCounts(requests: ModelRequestRecord[]): string {
	const pending = requests.filter((request) => request.status === "in_flight").length;
	const unknown = requests.filter((request) => request.status === "unknown").length;
	return `${pending ? ` · ${pending} in-flight` : ""}${unknown ? ` · ${unknown} unknown` : ""}`;
}

function reservations(budget?: BudgetTotals): string {
	return budget
		? ` · ${count(budget.reservedTokens)} reserved est (${count(budget.unknownTokens)} unknown) · ${count(budget.availableTokens)} available`
		: "";
}

/** Returned alongside usage; a zero reported subtotal does not confirm a zero bill. */
export function workflowUsageObservation(record: WorkflowRecord) {
	const requests = record.agents.flatMap((agent) => agent.requests ?? []);
	const unknownRequests = requests.filter((request) => request.status === "unknown").length;
	const inFlightRequests = requests.filter((request) => request.status === "in_flight").length;
	const unavailable = record.agents.some((agent) => !agent.requests || !agent.usage);
	return {
		source: "api_reported_cumulative",
		completeness: unavailable
			? "unavailable"
			: unknownRequests ||
					inFlightRequests ||
					record.status === "running" ||
					record.status === "paused" ||
					record.outcome === "unknown"
				? "partial"
				: "complete",
		unknownRequests,
		inFlightRequests,
		returnedToParentTokens: record.usageReportedTokens,
		lateReportedTokens:
			record.usageReportedTokens === undefined
				? undefined
				: Math.max(0, record.usage.totalTokens - record.usageReportedTokens),
		reservationObservation: "Estimates; unknown tokens are a subset of reserved tokens, not an additional debit",
		parentAccounting:
			"Known usage returned once only; late corrections remain visible here, not automatically re-billed",
	};
}

/** Reported cumulative tokens, never an estimate of still-unreported provider billing. */
export function workflowTokenLabel(record: WorkflowRecord): string {
	return `${count(record.usage.totalTokens)} tok reported${requestCounts(record.agents.flatMap((agent) => agent.requests ?? []))}${reservations(record.budget)}`;
}

export function agentTokenLabel(agent: AgentRecord): string {
	const tokens = agent.usage ? `${count(agent.usage.totalTokens)} tok reported` : "usage unavailable";
	return tokens + requestCounts(agent.requests ?? []) + reservations(agent.budget);
}

/** Put tokens before free-form labels so narrow terminals don't hide the usage again. */
export function workflowBacklogRows(records: WorkflowRecord[]): string[] {
	const live = records.filter((record) => record.status === "running" || record.status === "paused");
	const slots = Math.max(0, 4 - live.length);
	const recent = slots ? records.filter((record) => !live.includes(record)).slice(-slots) : [];
	return [...live, ...recent].slice(0, 4).flatMap((record) => {
		const running = record.agents.filter((agent) => agent.status === "running");
		const queued = record.agents.filter((agent) => agent.status === "queued");
		const visible = running.length ? running : queued.length ? queued.slice(-2) : record.agents.slice(-1);
		return [
			`[${record.status}${record.outcome ? `/${record.outcome}` : ""}] ${workflowTokenLabel(record)} · ${record.id.slice(0, 17)} ${safeText(record.label).replaceAll("\n", " ")} · ${safeText(record.phase).replaceAll("\n", " ")}`,
			...visible.map((agent) => {
				const last = agent.requests?.at(-1);
				const request = last
					? ` · req ${agent.requests!.length} ${last.status}${last.status === "reported" && last.usage ? ` ${count(last.usage.totalTokens)} tok` : ""}`
					: "";
				return `  ${agent.role}/${agent.status} · ${agentTokenLabel(agent)}${request} · ${safeText(agent.label).replaceAll("\n", " ")}`;
			}),
			...(queued.length ? [`  ${queued.length} queued · full request history: /workflow status ${record.id}`] : []),
		];
	});
}
