import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { thinkingSchema } from "./types.ts";

const number = Type.Number({ minimum: 0 });
export const usageSchema = Type.Object({
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	totalTokens: number,
	cost: Type.Object({ input: number, output: number, cacheRead: number, cacheWrite: number, total: number }),
});
export const requestEstimateSchema = Type.Object(
	{
		estimatedInputTokens: Type.Integer({ minimum: 0 }),
		maxOutputTokens: Type.Integer({ minimum: 1 }),
		marginTokens: Type.Integer({ minimum: 0 }),
		estimator: StringEnum(["context_usage_and_chars", "trusted_host"] as const),
	},
	{ additionalProperties: false },
);
export const progressSchema = Type.Object({
	partial: Type.Literal(true),
	output: Type.String({ maxLength: 8192 }),
	outputTruncated: Type.Boolean(),
	operations: Type.Array(
		Type.Object({
			id: Type.String({ maxLength: 200 }),
			name: Type.String({ maxLength: 200 }),
			path: Type.Optional(Type.String({ maxLength: 512 })),
			mutation: Type.Boolean(),
			status: StringEnum(["started", "completed", "failed", "unknown"] as const),
			result: Type.Optional(Type.String({ maxLength: 2000 })),
			truncated: Type.Optional(Type.Boolean()),
		}),
		{ maxItems: 64 },
	),
	droppedOperations: Type.Integer({ minimum: 0 }),
	updatedAt: number,
});
const totalsSchema = Type.Object({
	limit: Type.Integer({ minimum: 1, maximum: 2000000 }),
	usage: usageSchema,
	reservedTokens: number,
	unknownTokens: number,
	availableTokens: number,
	overspentTokens: number,
	overcommittedTokens: Type.Optional(number),
});
const budgetRequestSchema = Type.Object({
	id: Type.String({ maxLength: 500 }),
	agentId: Type.String({ maxLength: 500 }),
	phaseId: Type.String({ maxLength: 500 }),
	estimatedInputTokens: number,
	maxOutputTokens: number,
	marginTokens: number,
	reservedTokens: number,
	status: StringEnum(["reserved", "dispatched", "unknown", "settled", "released"] as const),
	usage: Type.Optional(usageSchema),
	underestimatedTokens: Type.Optional(number),
});
const budgetSchema = Type.Object({
	...totalsSchema.properties,
	agents: Type.Array(Type.Object({ id: Type.String(), ...totalsSchema.properties }), { maxItems: 32 }),
	phases: Type.Array(Type.Object({ id: Type.String(), ...totalsSchema.properties }), { maxItems: 1024 }),
	requests: Type.Array(budgetRequestSchema, { maxItems: 2048 }),
});
export const recordSchema = Type.Object({
	id: Type.String({ pattern: "^workflow-[a-f0-9-]{36}$" }),
	label: Type.String({ maxLength: 500 }),
	cwd: Type.String(),
	provider: Type.String(),
	model: Type.String(),
	thinkingLevel: Type.Optional(thinkingSchema),
	status: StringEnum(["running", "paused", "awaiting_result", "archived"] as const),
	outcome: Type.Optional(StringEnum(["completed", "failed", "stopped", "unknown"] as const)),
	phase: Type.String({ maxLength: 500 }),
	phaseId: Type.Optional(Type.String()),
	phases: Type.Optional(
		Type.Array(Type.Object({ id: Type.String(), title: Type.String({ maxLength: 500 }) }), { maxItems: 1024 }),
	),
	budget: Type.Optional(budgetSchema),
	agents: Type.Array(
		Type.Object({
			id: Type.String(),
			role: StringEnum(["scout", "worker", "reviewer", "summarizer"] as const),
			label: Type.String({ maxLength: 200 }),
			phase: Type.String({ maxLength: 500 }),
			phaseId: Type.Optional(Type.String()),
			budget: Type.Optional(totalsSchema),
			progress: Type.Optional(progressSchema),
			status: StringEnum(["queued", "running", "completed", "failed", "stopped"] as const),
			output: Type.Optional(Type.String({ maxLength: 16384 })),
			outputTruncated: Type.Optional(Type.Boolean()),
			outputOriginalLength: Type.Optional(Type.Integer({ minimum: 0 })),
			error: Type.Optional(Type.String({ maxLength: 2000 })),
			turns: Type.Optional(number),
			usage: Type.Optional(usageSchema),
			requests: Type.Optional(
				Type.Array(
					Type.Object({
						id: Type.String(),
						status: StringEnum(["in_flight", "reported", "unknown", "not_sent"] as const),
						source: StringEnum(["request_gate", "usage_only"] as const),
						estimate: Type.Optional(requestEstimateSchema),
						reservedTokens: Type.Optional(number),
						underestimatedTokens: Type.Optional(number),
						startedAt: Type.Optional(number),
						dispatchedAt: Type.Optional(number),
						reportedAt: Type.Optional(number),
						usage: Type.Optional(usageSchema),
					}),
					{ maxItems: 64 },
				),
			),
			thinkingLevel: Type.Optional(thinkingSchema),
		}),
		{ maxItems: 32 },
	),
	usage: usageSchema,
	createdAt: number,
	updatedAt: number,
	result: Type.Optional(Type.String({ maxLength: 65536 })),
	resultTruncated: Type.Optional(Type.Boolean()),
	resultOriginalLength: Type.Optional(Type.Integer({ minimum: 0 })),
	deliveryComplete: Type.Optional(Type.Boolean()),
	error: Type.Optional(Type.String({ maxLength: 2000 })),
	resultRead: Type.Optional(Type.Boolean()),
	usageReported: Type.Optional(Type.Boolean()),
	usageReportedTokens: Type.Optional(number),
	acknowledgedAt: Type.Optional(number),
	acknowledgement: Type.Optional(Type.String({ maxLength: 1000 })),
});
export const controlSchema = Type.Object(
	{
		action: StringEnum(["phase", "log", "checkpoint"] as const),
		text: Type.Optional(Type.String({ maxLength: 500 })),
		maxTotalTokens: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000000 })),
	},
	{ additionalProperties: false },
);
