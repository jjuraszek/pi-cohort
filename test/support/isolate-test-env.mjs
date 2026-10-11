import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", "pct-"));
const home = path.join(root, "home");
const temp = path.join(root, "tmp");
fs.mkdirSync(home);
fs.mkdirSync(temp);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.TMPDIR = temp;
process.env.TEMP = temp;
process.env.TMP = temp;
