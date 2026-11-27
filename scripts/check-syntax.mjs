// Syntax-checks every JavaScript file under functions/, src/ and scripts/ with `node --check`.
// It finds the files itself, so a new module can't be left out the way a hand-written list can.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOTS = ["functions", "src", "scripts"];
const JS_FILE = /\.(c|m)?js$/;

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : listFiles(path);
    return JS_FILE.test(entry.name) ? [path] : [];
  });
}

const files = ROOTS.flatMap(listFiles).sort();
const failures = files.filter((file) => {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  return result.status !== 0;
});

if (failures.length > 0) {
  console.error(`Syntax errors in ${failures.length} of ${files.length} files: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`Syntax OK: ${files.length} files`);
