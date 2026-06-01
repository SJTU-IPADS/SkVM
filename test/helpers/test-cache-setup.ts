import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Always redirect SKVM_CACHE to a fresh temp dir — never honor an inherited
// value. Bun auto-loads the repo `.env` at process startup, *before* this
// preload runs, and that file sets SKVM_CACHE to the developer's in-tree cache.
// A `if (!process.env.SKVM_CACHE)` guard would therefore see it already set and
// skip, letting the whole suite read, write, and (via test-env's exit sweeper)
// delete the real ~/.skvm / in-tree .skvm — defeating isolation. Tests that
// need their own cache override it at runtime (with invalidateConfigCache);
// this is only the hermetic default for every worker.
process.env.SKVM_CACHE = mkdtempSync(path.join(os.tmpdir(), "skvm-test-"))
