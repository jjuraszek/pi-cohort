/**
 * Fixture execution backend for detached-external-orchestration tests.
 *
 * Implements the ExecutionBackend contract by actually spawning the child host
 * runtime passed in the launch request. Writes trace events to
 * PI_COHORT_FIXTURE_TRACE so tests can assert launch/close/release lifecycle.
 * A close for `explicit_cleanup` kills the host's process group.
 *
 * The handle carries an extra `metadata` field with { fixture: "detached-package" }
 * so tests can verify the handle was produced by this backend.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";

function writeTrace(type: string, fields: Record<string, unknown>): void {
	const tracePath = process.env["PI_COHORT_FIXTURE_TRACE"];
	if (!tracePath) return;
	try {
		fs.appendFileSync(tracePath, JSON.stringify({ type, ...fields, ts: Date.now() }) + "\n");
	} catch {}
}

export function createFixtureExecutionBackend() {
	const hostPids = new Map<string, number>();
	return {
		name: "fixture-detached" as const,
		protocolVersion: 1 as const,

		async detect() {
			return { available: true, version: "1", capabilities: ["interactive"] };
		},

		async launch(request: {
			command: string;
			args: readonly string[];
			cwd: string;
			environment: Record<string, string>;
			runId: string;
			childId: string;
			signal: AbortSignal;
			awareness?: Record<string, unknown>;
		}) {
			const env: Record<string, string> = {};
			for (const [k, v] of Object.entries(request.environment)) {
				if (v !== undefined) env[k] = v;
			}

			const child = spawn(request.command, [...request.args], {
				cwd: request.cwd,
				env,
				stdio: ["ignore", "ignore", "ignore"],
				// Its own process group, so a forced close ends the host and its pi together as closing a terminal tab does.
				detached: true,
			});
			const pid = child.pid ?? 0;

			const handle = {
				protocolVersion: 1 as const,
				backend: "fixture-detached",
				surface: { kind: "fixture", id: `${request.runId}--${request.childId}` },
				display: { label: `fixture ${request.childId}`, hint: "durable" },
				data: null as null,
				// Extra field for test assertion (not part of the interface contract).
				metadata: { fixture: "detached-package", runId: request.runId, childId: request.childId },
			};

			hostPids.set(handle.surface.id, pid);
			writeTrace("launch", { runId: request.runId, childId: request.childId, pid, options: request.awareness?.options });

			const events = (async function* () {
				const exitInfo = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
					child.once("exit", (code, signal) =>
						resolve({ code, signal: signal as string | null }),
					);
					child.once("error", () => resolve({ code: 1, signal: null }));
				});
				yield {
					timestamp: Date.now(),
					source: "mux" as const,
					surface: handle.surface,
					type: "exited" as const,
					status: exitInfo.code,
					signal: exitInfo.signal,
				};
			})();

			return {
				handle,
				events,
				async reconcile() { return []; },
				async release() {
					writeTrace("release", { runId: request.runId, childId: request.childId });
				},
			};
		},

		async reattach() {
			return { status: "gone" as const };
		},

		async close(handle: { surface: { id: string }; metadata?: { runId?: string; childId?: string } }, reason: string) {
			writeTrace("close", {
				runId: handle.metadata?.runId ?? "",
				childId: handle.metadata?.childId ?? "",
				reason,
			});
			const pid = hostPids.get(handle.surface.id);
			if (reason === "explicit_cleanup" && pid) {
				try { process.kill(-pid, "SIGKILL"); } catch {}
			}
		},
	};
}
