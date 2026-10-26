import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repo = process.env.RUNTIME_TEST_REPO;
const request = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const { createSubagentExecutor } = await import(pathToFileURL(path.join(repo, "src/runs/foreground/subagent-executor.ts")));
const { createEventBus, makeAgent, makeMinimalCtx } = await import(pathToFileURL(path.join(repo, "test/support/helpers.ts")));
const types = await import(pathToFileURL(path.join(repo, "src/shared/types.ts")));

const state = { baseCwd: request.cwd, currentSessionId: null, asyncJobs: new Map(), grandTotal: { mainCost: 0, syncCostByRun: new Map(), asyncCostByJob: new Map(), externalCostBySource: new Map() }, foregroundControls: new Map(), lastForegroundControlId: null };
const executor = createSubagentExecutor({
	pi: { events: createEventBus(), getSessionName: () => undefined }, state, resolveConfig: () => ({}),
	tempArtifactsDir: types.TEMP_ARTIFACTS_DIR,
	getSubagentSessionRoot: () => path.join(types.RUN_STATE_ROOT_DIR, "sessions"),
	expandTilde: value => value, discoverAgents: () => ({ agents: [makeAgent("worker", request.agent)] }),
});
if (request.renameAfterCapture) fs.renameSync(request.renameAfterCapture, `${request.renameAfterCapture}.missing`);
try {
	const result = await executor.execute("sdk-host-proof", { agent: "worker", task: request.task }, new AbortController().signal, undefined, makeMinimalCtx(request.cwd));
	fs.writeFileSync(request.output, JSON.stringify({ argv1: fs.realpathSync.native(process.argv[1]), result }));
} finally {
	if (request.renameAfterCapture) fs.renameSync(`${request.renameAfterCapture}.missing`, request.renameAfterCapture);
}
