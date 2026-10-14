import {
	createCodemodeExtension,
	type ExtensionAPI,
	SessionManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ScriptRunner } from "./types.ts";

/** Reuse the public codemode extension so source/npm/compiled hosts resolve their own worker and wasm assets. */
export function createScriptRunner(pi: ExtensionAPI): ScriptRunner {
	let definition: ToolDefinition | undefined;
	// Capture the tool rather than registering another codemode in the main session. None of the
	// parent's tools, globals, store, model discovery or namespace descriptions enter this runtime.
	const registration: ExtensionAPI = new Proxy(pi, {
		get(target, property, receiver) {
			if (property === "registerTool")
				return (tool: ToolDefinition) => {
					definition = tool;
				};
			if (property === "getAllTools") return () => [];
			if (property === "appendEntry") return () => {};
			return Reflect.get(target, property, receiver);
		},
	});
	createCodemodeExtension({ mode: "on", models: false })(registration);
	const tool = definition;
	if (!tool) throw new Error("Host did not register the codemode runtime");
	return async (code, ctx, signal) => {
		// Disabling appendEntry only blocks writes; Codemode still reads its supplied branch.
		// A fresh non-persisting owner keeps parent history/store out without mutating parent ctx.
		const context = { ...ctx, sessionManager: SessionManager.inMemory(ctx.cwd) };
		const result = await tool.execute("workflow-script", { code }, signal, undefined, context);
		const details = result.details;
		// Codemode exposes a spill path, but no truncation flag on failed spill. Its
		// warning is a conservative fallback: a script quoting it may be marked partial,
		// never the reverse. Do not invent the original length of upstream-truncated text.
		const fullOutputPath =
			typeof details === "object" &&
			details !== null &&
			"fullOutputPath" in details &&
			typeof details.fullOutputPath === "string"
				? details.fullOutputPath
				: undefined;
		const outputTruncated =
			fullOutputPath !== undefined ||
			result.content.some((part) => part.type === "text" && part.text.startsWith("Warning: truncated output ("));
		return { ...result, outputTruncated, ...(fullOutputPath !== undefined ? { fullOutputPath } : {}) };
	};
}

/** Helpers live inside QuickJS. The only host capabilities are the two validated bridge tools. */
export const prelude = `
const agent = (prompt, options = {}) => tools.workflow_agent({prompt, ...options});
const phase = (title, options = {}) => tools.workflow_control({...options, action: "phase", text: title});
const log = (message) => tools.workflow_control({action: "log", text: String(message)});
const checkpoint = () => tools.workflow_control({action: "checkpoint"});
async function parallel(tasks) {
  if (!Array.isArray(tasks) || tasks.length > 32) throw new Error("parallel expects at most 32 functions or prompts");
  return Promise.all(tasks.map(task => typeof task === "function" ? task() : agent(task)));
}
async function pipeline(items, mapper, options = {}) {
  if (!Array.isArray(items) || items.length > 32 || typeof mapper !== "function") throw new Error("pipeline expects at most 32 items and a mapper");
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("pipeline concurrency must be 1–4");
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (next < items.length) { const i = next++; results[i] = await mapper(items[i], i); }
  }));
  return results;
}
// Keep the shared projection private; only the two explicit helpers enter script scope.
const [parallelSettled, pipelineSettled] = (() => {
  async function settle(invoke) {
    try {
      return {status: "fulfilled", value: await invoke()};
    } catch (error) {
      let reason = "Unprintable rejection";
      try { reason = String(error); } catch {}
      return {status: "rejected", reason: reason.slice(0, 2000), reasonTruncated: reason.length > 2000};
    }
  }
  return [
    async (tasks) => {
      const size = Array.isArray(tasks) ? tasks.length : -1;
      if (!Number.isInteger(size) || size < 0 || size > 32) throw new Error("parallelSettled expects at most 32 functions or prompts");
      return Promise.all(Array.from({length: size}, (_, i) => settle(() => {
        const task = tasks[i];
        return typeof task === "function" ? task() : agent(task);
      })));
    },
    async (items, mapper, options = {}) => {
      const size = Array.isArray(items) ? items.length : -1;
      if (!Number.isInteger(size) || size < 0 || size > 32 || typeof mapper !== "function") throw new Error("pipelineSettled expects at most 32 items and a mapper");
      // Reuse the existing bounded loop over fixed positions, not a second scheduler.
      return pipeline(Array.from({length: size}, (_, i) => i),
        i => settle(() => mapper(items[i], i)), options);
    }
  ];
})();
`;
