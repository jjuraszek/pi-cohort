import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import registerSubagentExtension from "../../src/extension/index.ts";
import { SUBAGENT_CHILD_ENV } from "../../src/runs/shared/pi-args.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
let root: string;
let profile: string;
let legacy: string;
let oldProfile: string | undefined;
let oldChild: string | undefined;
let handlers: Map<string, Handler>;
let notifications: { message: string; level: string }[];
let warnings: string[];
let originalWarn: typeof console.warn;

function write(file: string, content: string) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function register() {
	const emitter = new EventEmitter();
	const target = {
		events: {
			on(name: string, handler: (...args: any[]) => void) {
				emitter.on(name, handler);
				return () => emitter.off(name, handler);
			},
			emit: (name: string, payload: unknown) => emitter.emit(name, payload),
		},
		on: (name: string, handler: Handler) => handlers.set(name, handler),
	};
	registerSubagentExtension(new Proxy(target, {
		get: (object, key) => key in object ? object[key as keyof typeof object] : () => undefined,
	}) as never);
}

function start(cwd = root, hasUI = true) {
	handlers.get("session_start")!({}, {
		cwd, hasUI,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
			setStatus() {}, setWidget() {}, requestRender() {},
		},
		sessionManager: {
			getSessionId: () => "settings-test", getSessionFile: () => null,
			getEntries: () => [], getBranch: () => [],
		},
	});
}

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "cohort-session-settings-"));
	profile = path.join(root, "profile");
	legacy = path.join(profile, "extensions", "pi-cohort", "config.json");
	oldProfile = process.env.PI_CODING_AGENT_DIR;
	oldChild = process.env[SUBAGENT_CHILD_ENV];
	process.env.PI_CODING_AGENT_DIR = profile;
	delete process.env[SUBAGENT_CHILD_ENV];
	handlers = new Map();
	notifications = [];
	warnings = [];
	originalWarn = console.warn;
	console.warn = (message) => warnings.push(String(message));
});

afterEach(() => {
	handlers.get("session_shutdown")?.({}, {});
	console.warn = originalWarn;
	if (oldProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = oldProfile;
	if (oldChild === undefined) delete process.env[SUBAGENT_CHILD_ENV];
	else process.env[SUBAGENT_CHILD_ENV] = oldChild;
	fs.rmSync(root, { recursive: true, force: true });
});

for (const [name, content] of [["populated", '{"showRosterOnStart":false}'], ["empty", ""], ["invalid", "{"]] as const) {
	for (const hasUI of [true, false]) {
		it(`warns once for ${name} legacy file with hasUI=${hasUI}, ignoring its values`, () => {
			write(legacy, content);
			register();
			start(root, hasUI);
			const uiWarnings = notifications.filter((entry) => entry.level === "warning").map((entry) => entry.message);
			assert.equal((hasUI ? warnings : uiWarnings).length, 0);
			const messages = hasUI ? uiWarnings : warnings;
			assert.equal(messages.length, 1);
			assert.ok(messages[0].includes(legacy));
			assert.ok(messages[0].includes("pi-cohort no longer reads this file"));
			assert.ok(messages[0].includes("move its keys under `subagents` in `settings.json`"));
			assert.equal(notifications.filter((entry) => entry.level === "info").length, hasUI ? 1 : 0);
		});
	}
}

it("does not warn when the legacy path is absent", () => {
	register();
	start();
	assert.deepEqual(warnings, []);
	assert.equal(notifications.filter((entry) => entry.level === "warning").length, 0);
});

it("resolves roster settings again at the second session cwd despite conflicting legacy values", () => {
	write(legacy, '{"showRosterOnStart":true}');
	const hidden = path.join(root, "hidden");
	const shown = path.join(root, "shown");
	write(path.join(hidden, ".pi", "settings.json"), '{"subagents":{"showRosterOnStart":false}}');
	write(path.join(shown, ".pi", "settings.json"), '{"subagents":{"showRosterOnStart":true}}');
	register();
	start(hidden);
	assert.equal(notifications.filter((entry) => entry.level === "info").length, 0);
	start(shown);
	assert.equal(notifications.filter((entry) => entry.level === "info").length, 1);
	assert.equal(notifications.filter((entry) => entry.level === "warning").length, 2);
});

it("excludes child registration before installing session callbacks", () => {
	write(legacy, '{"showRosterOnStart":true}');
	process.env[SUBAGENT_CHILD_ENV] = "1";
	register();
	assert.equal(handlers.size, 0);
	assert.deepEqual(notifications, []);
	assert.deepEqual(warnings, []);
});
