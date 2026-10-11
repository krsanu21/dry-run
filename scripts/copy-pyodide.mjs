// Copies the Pyodide runtime from node_modules into public/pyodide so the app
// serves it locally. Nothing is downloaded at execution time.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pyodide");
const dest = join(root, "public", "pyodide");
const files = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"];

if (!existsSync(src)) {
  console.warn("[copy-pyodide] pyodide package not installed; skipping");
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
for (const f of files) {
  const from = join(src, f);
  if (!existsSync(from)) {
    console.error(`[copy-pyodide] missing ${f} in pyodide package`);
    process.exit(1);
  }
  cpSync(from, join(dest, f));
}
console.log(`[copy-pyodide] copied ${files.length} files to public/pyodide`);
