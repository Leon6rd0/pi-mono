import { createCodemodeExtension, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
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
	return (code, ctx, signal) => tool.execute("workflow-script", { code }, signal, undefined, ctx);
}

/** Helpers live inside QuickJS. The only host capabilities are the two validated bridge tools. */
export const prelude = `
const agent = (prompt, options = {}) => tools.workflow_agent({prompt, ...options});
const phase = (title) => tools.workflow_control({action: "phase", text: title});
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
`;
