import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { discoverAgents, discoverAgentsAll, saveBuiltinAgentOverride } from "../../src/agents/agents.ts";

let tempDir = "";
let repoRoot = "";
let oldEnv: Record<string, string | undefined> = {};

function writeFile(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function agentFile(name: string, where: string): string {
	return `---\nname: ${name}\ndescription: ${name} persona\n---\n\nDefined in ${where}.\n`;
}

function makeRepo(): { repoRoot: string } {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "repo-")));
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	return { repoRoot: root };
}

describe("persona discovery walks to git root", () => {
	beforeEach(() => {
		oldEnv = {
			HOME: process.env.HOME,
			USERPROFILE: process.env.USERPROFILE,
			PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		};
		tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "discovery-walk-")));
		const emptyHome = path.join(tempDir, "home");
		const emptyAgentDir = path.join(tempDir, "agent");
		fs.mkdirSync(emptyHome, { recursive: true });
		fs.mkdirSync(emptyAgentDir, { recursive: true });
		process.env.HOME = emptyHome;
		process.env.USERPROFILE = emptyHome;
		process.env.PI_CODING_AGENT_DIR = emptyAgentDir;
		({ repoRoot } = makeRepo());
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(oldEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("finds a root-level agent from a nested subdir", () => {
		writeFile(path.join(repoRoot, ".agents", "root-only.md"), agentFile("root-only", "repo-root"));
		const subdir = path.join(repoRoot, "svc", "api");
		fs.mkdirSync(subdir, { recursive: true });
		// Anchor discovery at the subdir the way the bug does: a local .agents marker.
		writeFile(path.join(subdir, ".agents", "local.md"), agentFile("local", "subdir"));

		const result = discoverAgents(subdir, "both");
		assert.ok(result.agents.find((a) => a.name === "root-only"), "root-level agent must be visible from subdir");
		assert.ok(result.agents.find((a) => a.name === "local"), "subdir agent must still be visible");
	});

	it("nearest level wins on name collision", () => {
		writeFile(path.join(repoRoot, ".agents", "shared.md"), agentFile("shared", "repo-root"));
		const svc = path.join(repoRoot, "svc");
		writeFile(path.join(svc, ".pi", "agents", "shared.md"), agentFile("shared", "svc-nearest"));

		const result = discoverAgents(svc, "both");
		assert.match(result.agents.find((a) => a.name === "shared")?.systemPrompt ?? "", /svc-nearest/);
	});

	it("within a level, .pi/agents beats .agents", () => {
		writeFile(path.join(repoRoot, ".agents", "dup.md"), agentFile("dup", "legacy"));
		writeFile(path.join(repoRoot, ".pi", "agents", "dup.md"), agentFile("dup", "preferred"));

		const result = discoverAgents(repoRoot, "both");
		assert.match(result.agents.find((a) => a.name === "dup")?.systemPrompt ?? "", /preferred/);
	});

	it("a nearest .pi symlinked to a farther real dir still beats a same-level .agents", () => {
		writeFile(path.join(repoRoot, ".pi", "agents", "shared.md"), agentFile("shared", "root-pi"));
		const mid = path.join(repoRoot, "mid");
		writeFile(path.join(mid, ".agents", "shared.md"), agentFile("shared", "mid-legacy"));
		// mid/.pi -> repo/.pi (symlink); mid/.pi/agents resolves to repo/.pi/agents.
		fs.symlinkSync(path.join(repoRoot, ".pi"), path.join(mid, ".pi"), "dir");

		const result = discoverAgents(mid, "both");
		const shared = result.agents.find((a) => a.name === "shared");
		// dedupeByRealPath collapses the symlinked mid/.pi/agents (-> repo/.pi/agents) so it
		// is loaded once; its correctness is a non-observable perf optimization here (the
		// name-keyed merge would dedup the value anyway). What this asserts is the WINNER:
		// the nearest .pi/agents (root-pi via the symlink) beats the same-level mid/.agents.
		assert.match(shared?.systemPrompt ?? "", /root-pi/, "symlinked nearest .pi/agents wins over mid/.agents");
	});

	it("falls back to nearest-only when not in a git repo", () => {
		const nonRepo = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "nogit-")));
		writeFile(path.join(nonRepo, ".agents", "outer.md"), agentFile("outer", "outer"));
		const inner = path.join(nonRepo, "inner");
		writeFile(path.join(inner, ".agents", "inner.md"), agentFile("inner", "inner"));

		const result = discoverAgents(inner, "both");
		assert.ok(result.agents.find((a) => a.name === "inner"), "nearest root is read");
		assert.equal(result.agents.find((a) => a.name === "outer"), undefined, "no walk without a git root");
	});

	it("treats a .git file (worktree) as the git root boundary", () => {
		const wtRoot = fs.realpathSync(fs.mkdtempSync(path.join(tempDir, "wt-")));
		fs.writeFileSync(path.join(wtRoot, ".git"), "gitdir: /somewhere/.git/worktrees/wt\n", "utf-8");
		writeFile(path.join(wtRoot, ".agents", "wt-agent.md"), agentFile("wt-agent", "wt-root"));
		const deep = path.join(wtRoot, "a", "b");
		writeFile(path.join(deep, ".agents", "leaf.md"), agentFile("leaf", "leaf"));

		const result = discoverAgents(deep, "both");
		assert.ok(result.agents.find((a) => a.name === "wt-agent"), "agent at the .git-file root is visible from a subdir");
		assert.ok(result.agents.find((a) => a.name === "leaf"), "innermost agent is still visible");
	});

	function chainFile(name: string, where: string): string {
		return `---\nname: ${name}\ndescription: ${name} chain (${where})\n---\n\n## local\n\nStep in ${where}.\n`;
	}

	it("discovers a root-level chain from a nested subdir (chains read .pi/chains)", () => {
		writeFile(path.join(repoRoot, ".pi", "chains", "root-chain.chain.md"), chainFile("root-chain", "repo-root"));
		const svc = path.join(repoRoot, "svc");
		// chain-only level: only .pi/chains, no .agents/.pi/agents - must still participate.
		writeFile(path.join(svc, ".pi", "chains", "svc-chain.chain.md"), chainFile("svc-chain", "svc"));

		const discovered = discoverAgentsAll(svc);
		assert.ok(discovered.chains.find((c) => c.name === "root-chain"), "root chain visible from subdir");
		assert.ok(discovered.chains.find((c) => c.name === "svc-chain"), "subdir chain visible");
	});

	it("nearest level wins on chain name collision", () => {
		writeFile(path.join(repoRoot, ".pi", "chains", "dup.chain.md"), chainFile("dup", "repo-root"));
		const svc = path.join(repoRoot, "svc");
		writeFile(path.join(svc, ".pi", "chains", "dup.chain.md"), chainFile("dup", "svc-nearest"));

		const discovered = discoverAgentsAll(svc);
		assert.match(discovered.chains.find((c) => c.name === "dup")?.description ?? "", /svc-nearest/);
	});

	it("merges agentOverrides across levels with nearest winning per name", () => {
		writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({
			subagents: { agentOverrides: {
				worker: { systemPrompt: "root worker" },
				planner: { systemPrompt: "root planner" },
			} },
		}, null, 2));
		const svc = path.join(repoRoot, "svc");
		writeFile(path.join(svc, ".agents", "anchor.md"), agentFile("anchor", "svc"));
		writeFile(path.join(svc, ".pi", "settings.json"), JSON.stringify({
			subagents: { agentOverrides: { worker: { systemPrompt: "svc worker" } } },
		}, null, 2));

		const result = discoverAgents(svc, "both");
		assert.equal(result.agents.find((a) => a.name === "worker")?.systemPrompt, "svc worker", "nearest override wins");
		assert.equal(result.agents.find((a) => a.name === "planner")?.systemPrompt, "root planner", "farther-only override still applies");
	});

	it("disableBuiltins is taken from the nearest level that defines it", () => {
		writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({
			subagents: { disableBuiltins: true },
		}, null, 2));
		const svc = path.join(repoRoot, "svc");
		writeFile(path.join(svc, ".agents", "anchor.md"), agentFile("anchor", "svc"));
		writeFile(path.join(svc, ".pi", "settings.json"), JSON.stringify({
			subagents: { disableBuiltins: false },
		}, null, 2));

		const result = discoverAgents(svc, "both");
		assert.ok(result.agents.find((a) => a.name === "worker"), "nearer disableBuiltins:false overrides farther true");
	});

	it("a settings-only level (no .agents/.pi/agents) still contributes overrides", () => {
		writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({
			subagents: { agentOverrides: { worker: { systemPrompt: "root-settings-only" } } },
		}, null, 2));
		const svc = path.join(repoRoot, "svc");
		writeFile(path.join(svc, ".agents", "anchor.md"), agentFile("anchor", "svc"));

		const result = discoverAgents(svc, "both");
		assert.equal(result.agents.find((a) => a.name === "worker")?.systemPrompt, "root-settings-only");
	});

	it("skips a malformed settings file mid-walk and merges the rest", () => {
		writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({
			subagents: { agentOverrides: { worker: { systemPrompt: "root worker" } } },
		}, null, 2));
		const svc = path.join(repoRoot, "svc");
		writeFile(path.join(svc, ".agents", "anchor.md"), agentFile("anchor", "svc"));
		// writeFile creates parent dirs; overwrite with invalid JSON to simulate malformed settings.
		writeFile(path.join(svc, ".pi", "settings.json"), "{}");
		fs.writeFileSync(path.join(svc, ".pi", "settings.json"), "{ not valid json", "utf-8");

		const result = discoverAgents(svc, "both");
		assert.equal(result.agents.find((a) => a.name === "worker")?.systemPrompt, "root worker", "good level still merges when a nearer one is malformed");
	});

	it("agentOverrides merge is whole-object per name (disjoint fields do not compose)", () => {
		writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({
			subagents: { agentOverrides: { worker: { systemPrompt: "root prompt", model: "root/model" } } },
		}, null, 2));
		const svc = path.join(repoRoot, "svc");
		writeFile(path.join(svc, ".agents", "anchor.md"), agentFile("anchor", "svc"));
		writeFile(path.join(svc, ".pi", "settings.json"), JSON.stringify({
			subagents: { agentOverrides: { worker: { systemPrompt: "svc prompt" } } },
		}, null, 2));

		const worker = discoverAgents(svc, "both").agents.find((a) => a.name === "worker");
		assert.equal(worker?.systemPrompt, "svc prompt", "nearest entry replaces wholesale");
		assert.equal(worker?.model, undefined, "farther 'model' is NOT composed into the nearest entry");
	});

	it("override writes target the nearest project root even when reads merged from farther", () => {
		writeFile(path.join(repoRoot, ".pi", "settings.json"), JSON.stringify({ subagents: {} }, null, 2));
		const svc = path.join(repoRoot, "svc");
		writeFile(path.join(svc, ".agents", "anchor.md"), agentFile("anchor", "svc"));

		const written = saveBuiltinAgentOverride(svc, "worker", "project", { systemPrompt: "from svc" });
		assert.equal(written, path.join(svc, ".pi", "settings.json"), "write lands at the nearest root, not the git root");
		assert.equal(fs.existsSync(path.join(repoRoot, ".pi", "settings.json")) && JSON.parse(fs.readFileSync(path.join(repoRoot, ".pi", "settings.json"), "utf-8")).subagents?.agentOverrides, undefined, "git-root settings untouched");
	});

	it("create target (projectDir) is the nearest .pi/agents, not the git root", () => {
		writeFile(path.join(repoRoot, ".agents", "root.md"), agentFile("root", "repo-root"));
		const svc = path.join(repoRoot, "svc");
		writeFile(path.join(svc, ".agents", "anchor.md"), agentFile("anchor", "svc"));

		// handleCreate (agent-management.ts:506) writes to discoverAgentsAll().projectDir.
		assert.equal(discoverAgentsAll(svc).projectDir, path.join(svc, ".pi", "agents"));
	});

	it("a farthest-ancestor project agent outranks a same-named user agent", () => {
		// process.env.HOME points at the empty temp home; populate ~/.agents.
		writeFile(path.join(process.env.HOME as string, ".agents", "shared.md"), agentFile("shared", "user-home"));
		writeFile(path.join(repoRoot, ".agents", "shared.md"), agentFile("shared", "repo-root-project"));
		const svc = path.join(repoRoot, "svc", "api");
		writeFile(path.join(svc, ".agents", "anchor.md"), agentFile("anchor", "svc"));

		const result = discoverAgents(svc, "both");
		assert.match(result.agents.find((a) => a.name === "shared")?.systemPrompt ?? "", /repo-root-project/, "any project level beats user roots");
	});
});
