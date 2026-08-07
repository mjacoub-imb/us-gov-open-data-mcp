/**
 * WASM-sandboxed JavaScript executor for code mode.
 *
 * Runs LLM-generated processing scripts against raw tool output in a QuickJS
 * WASM sandbox. The sandbox has NO filesystem or network access — only DATA
 * (the tool's response as a string) and console.log() for output.
 *
 * Usage:
 *   import { executeInSandbox } from "./sandbox.js";
 *   const result = await executeInSandbox(rawJsonString, userScript);
 *   // result.stdout contains only what the script console.log()'d
 *
 * The QuickJS WASM module is loaded once and reused across calls.
 * Each execution gets a fresh context (no state leakage between calls).
 */

import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";
import type { QuickJSWASMModule } from "quickjs-emscripten";

// ─── Singleton ───────────────────────────────────────────────────────

let _quickJS: QuickJSWASMModule | null = null;

/** Load QuickJS once, reuse across all executions. */
async function getRuntime(): Promise<QuickJSWASMModule> {
  if (!_quickJS) _quickJS = await getQuickJS();
  return _quickJS;
}

// ─── Types ───────────────────────────────────────────────────────────

export interface SandboxResult {
  /** Script's console.log() output. */
  stdout: string;
  /** Size of the input data in bytes. */
  beforeBytes: number;
  /** Size of the script output in bytes. */
  afterBytes: number;
  /** Context reduction percentage (0-100). */
  reductionPct: number;
  /** Script error message, if execution failed. */
  error?: string;
}

// ─── Configuration ───────────────────────────────────────────────────

/** Max script execution time in milliseconds. */
const TIMEOUT_MS = 10_000;

/** Max DATA size we'll inject into the sandbox (10MB). */
const MAX_DATA_BYTES = 10 * 1024 * 1024;

/**
 * Max stdout size we'll accumulate on the HOST (256KB).
 *
 * `runtime.setMemoryLimit()` below only bounds QuickJS's own WASM linear
 * memory — the `stdout` string built up in the console.log callback lives on
 * Node's heap and is NOT covered by that limit. A script that logs in a tight
 * loop (e.g. `for (;;) console.log("x".repeat(1e5))`) can grow stdout past
 * several hundred MB in under a second and OOM-kill the host process,
 * regardless of the sandbox's own memory cap.
 */
const MAX_STDOUT_BYTES = 256 * 1024;

/** Max concurrent sandbox executions. Each one reserves up to 64MB of WASM
 *  memory plus up to 10MB of DATA; unbounded concurrency on a shared process
 *  (e.g. behind the HTTP transport) can exhaust host memory well before any
 *  single execution's own limits kick in. */
const MAX_CONCURRENT = 3;
let _active = 0;
const _queue: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  if (_active < MAX_CONCURRENT) {
    _active++;
    return;
  }
  await new Promise<void>(resolve => _queue.push(resolve));
  _active++;
}

function releaseSlot(): void {
  _active--;
  const next = _queue.shift();
  if (next) next();
}

// ─── Executor ────────────────────────────────────────────────────────

/**
 * Execute a JavaScript script in a WASM sandbox with DATA injected.
 *
 * The script can:
 *   - Read `DATA` (string — the raw tool response)
 *   - Use `JSON.parse(DATA)` to parse it
 *   - Use `console.log(...)` to produce output
 *   - Use standard JS: loops, map/filter/reduce, string ops, Math, etc.
 *
 * The script CANNOT:
 *   - Access the filesystem
 *   - Make network requests
 *   - Import modules
 *   - Access Node.js APIs
 *   - Leak state between calls
 *
 * @param data - Raw tool response string (injected as `DATA` global)
 * @param script - JavaScript code to execute
 * @returns SandboxResult with stdout and size metrics
 */
export async function executeInSandbox(data: string, script: string): Promise<SandboxResult> {
  const beforeBytes = Buffer.byteLength(data, "utf-8");

  // Guard against huge payloads
  if (beforeBytes > MAX_DATA_BYTES) {
    return {
      stdout: "",
      beforeBytes,
      afterBytes: 0,
      reductionPct: 0,
      error: `DATA too large: ${(beforeBytes / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_DATA_BYTES / 1024 / 1024}MB limit.`,
    };
  }

  await acquireSlot();
  try {
    return await runScript(data, script, beforeBytes);
  } finally {
    releaseSlot();
  }
}

async function runScript(data: string, script: string, beforeBytes: number): Promise<SandboxResult> {
  const qjs = await getRuntime();
  const runtime = qjs.newRuntime();

  // Set interrupt handler for timeout
  const deadline = Date.now() + TIMEOUT_MS;
  const deadlineHandler = shouldInterruptAfterDeadline(deadline);
  let stdoutTruncated = false;
  runtime.setInterruptHandler(rt => stdoutTruncated || !!deadlineHandler(rt));

  // Memory limit: 64MB (generous for JSON processing). NOTE: this only bounds
  // QuickJS's own WASM memory — it does NOT bound the `stdout` string below,
  // which lives on the host's heap. See MAX_STDOUT_BYTES.
  runtime.setMemoryLimit(64 * 1024 * 1024);

  const vm = runtime.newContext();

  try {
    // ─── Inject DATA global ────────────────────────────────────────
    const dataHandle = vm.newString(data);
    vm.setProp(vm.global, "DATA", dataHandle);
    dataHandle.dispose();

    // ─── Capture console.log → stdout ──────────────────────────────
    let stdout = "";
    let stdoutBytes = 0;
    const logFn = vm.newFunction("log", (...args) => {
      if (stdoutTruncated) return;
      const parts = args.map(a => {
        // Handle different QuickJS types
        const type = vm.typeof(a);
        if (type === "string") return vm.getString(a);
        // For numbers, booleans, objects — dump and stringify
        let dumped: unknown;
        try {
          dumped = vm.dump(a);
        } catch {
          return "[unserializable]";
        }
        if (typeof dumped !== "object" || dumped === null) return String(dumped);
        try {
          return JSON.stringify(dumped);
        } catch {
          return "[circular or unserializable object]";
        }
      });
      const line = parts.join(" ") + "\n";
      stdoutBytes += Buffer.byteLength(line, "utf-8");
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        // Stop accumulating on the host heap immediately, and halt the script
        // on its next interrupt check — no point burning the rest of the
        // 10s timeout on output we're discarding.
        stdoutTruncated = true;
        stdout += `\n[output truncated at ${Math.round(MAX_STDOUT_BYTES / 1024)}KB — narrow your console.log calls]`;
        return;
      }
      stdout += line;
    });

    const consoleObj = vm.newObject();
    vm.setProp(consoleObj, "log", logFn);
    vm.setProp(vm.global, "console", consoleObj);
    logFn.dispose();
    consoleObj.dispose();

    // ─── Execute script ────────────────────────────────────────────
    const result = vm.evalCode(script);

    if (result.error) {
      // If we interrupted the script ourselves because stdout hit the cap,
      // that's not a script failure — return what we captured, truncated,
      // instead of surfacing the interrupt as an error.
      if (stdoutTruncated) {
        result.error.dispose();
        const trimmed = stdout.trimEnd();
        const afterBytes = Buffer.byteLength(trimmed, "utf-8");
        return {
          stdout: trimmed,
          beforeBytes,
          afterBytes,
          reductionPct: Math.max(0, beforeBytes > 0 ? (1 - afterBytes / beforeBytes) * 100 : 0),
        };
      }

      const errDump = vm.dump(result.error);
      result.error.dispose();
      const errMsg = typeof errDump === "object" ? JSON.stringify(errDump) : String(errDump);
      return {
        stdout: "",
        beforeBytes,
        afterBytes: 0,
        reductionPct: 0,
        error: errMsg,
      };
    }

    result.value.dispose();

    // ─── Compute metrics ───────────────────────────────────────────
    const trimmed = stdout.trimEnd();
    const afterBytes = Buffer.byteLength(trimmed, "utf-8");
    const reductionPct = beforeBytes > 0 ? (1 - afterBytes / beforeBytes) * 100 : 0;

    return {
      stdout: trimmed,
      beforeBytes,
      afterBytes,
      reductionPct: Math.max(0, reductionPct),
    };
  } finally {
    vm.dispose();
    runtime.dispose();
  }
}
