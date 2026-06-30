// tailwind.ts — server-side Tailwind v4 compile (styling pipeline).
//
// WHY THIS EXISTS: the Sandpack preview previously styled generated apps with
// the Tailwind Play CDN, whose JIT scans the live DOM. Generated dashboards
// render their real content only AFTER async data loads (behind `loading`
// gates), so the CDN's first scan sees an empty shell and many data-driven
// classes (e.g. group-hover:bg-indigo-100, xl:col-span-2, fill-amber-500,
// arbitrary values like max-w-[150px]) never get styled — the "flat / partially
// styled" output. Compiling from the SOURCE CODE instead of the DOM removes the
// race entirely: every class in App.tsx is captured regardless of when it mounts.
//
// v4 has no clean public string-compile API in Node (the maintainers point at
// either undocumented internals or a temp-file + CLI approach), so we take the
// stable, documented route: write the sources + a CSS entry to a temp dir, run
// the @tailwindcss/cli over them, read the CSS back, and clean up.
//
// BEST-EFFORT BY CONTRACT: any failure (missing CLI, timeout, non-zero exit)
// resolves to null. The caller ships the app without `css`, and the sandbox
// falls back to the Play CDN — styling degrades, the build never breaks.

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GeneratedFile } from "../shared/types";

const execFileAsync = promisify(execFile);
const requireFromHere = createRequire(import.meta.url);

const COMPILE_TIMEOUT_MS = Number(process.env.TAILWIND_COMPILE_TIMEOUT_MS ?? 15000);

/** Design tokens (v4 @theme). Inter + an elevated shadow scale so output sits
 *  above Tailwind's flat defaults. `@theme` is unlayered here (see the entry
 *  CSS below) so these merge with Tailwind's default theme. Keep in sync with
 *  the sandbox's fallback CDN config. */
const THEME = `@theme {
  --font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --shadow-sm: 0 1px 2px 0 rgb(15 23 42 / 0.04);
  --shadow: 0 1px 3px 0 rgb(15 23 42 / 0.06), 0 1px 2px -1px rgb(15 23 42 / 0.06);
  --shadow-md: 0 4px 12px -2px rgb(15 23 42 / 0.08), 0 2px 6px -2px rgb(15 23 42 / 0.05);
  --shadow-lg: 0 12px 28px -8px rgb(15 23 42 / 0.12), 0 4px 10px -4px rgb(15 23 42 / 0.08);
}`;

/** Resolve the Tailwind CLI's JS entry. We run it via `node <entry>` rather than
 *  the node_modules/.bin shim so it works cross-platform (the .bin entry is an
 *  extensionless shell script on Windows, which cmd.exe can't exec, and paths
 *  with spaces — e.g. OneDrive folders — break shelled-out commands). Overridable. */
function cliEntry(): string {
  if (process.env.TAILWIND_CLI_PATH) return process.env.TAILWIND_CLI_PATH;
  // The package's bin points at dist/index.mjs; resolve it from its package.json.
  const pkg = requireFromHere.resolve("@tailwindcss/cli/package.json");
  return join(pkg, "..", "dist", "index.mjs");
}

/** Compile Tailwind CSS from the generated app's source files.
 *  Returns the CSS string, or null on any failure (caller falls back to CDN).
 *  `run` is injectable so tests can exercise the logic without the real CLI. */
export async function compileCss(
  files: GeneratedFile[],
  run: (file: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<{ stdout: string; stderr: string }> =
    (file, args, opts) => execFileAsync(file, args, opts),
): Promise<string | null> {
  // Only the code files carry class names; skip anything non-.tsx/.jsx/.ts/.js.
  const codeFiles = files.filter((f) => /\.(jsx?|tsx?)$/i.test(f.path));
  if (!codeFiles.length) return null;

  let dir: string | null = null;
  try {
    // Temp dir lives INSIDE the project so the CLI's `@import "tailwindcss"`
    // resolves via Node's upward node_modules lookup (v4 resolves imports from
    // the CSS file's location, not --cwd). Cleaned up in `finally`.
    const base = join(process.cwd(), "node_modules", ".t2ui-tw");
    await mkdir(base, { recursive: true });
    dir = await mkdtemp(join(base, "c-"));

    // Write every source file under flat names so @source can reference them.
    const sourceNames: string[] = [];
    await Promise.all(
      codeFiles.map(async (f, i) => {
        const name = `src${i}.tsx`;
        sourceNames.push(name);
        await writeFile(join(dir!, name), f.content, "utf8");
      }),
    );

    // CSS entry. CRITICAL: we import Tailwind's sub-parts WITHOUT the usual
    // `@layer theme,base,components,utilities;` wrapper that bare
    // `@import "tailwindcss"` emits. That wrapper puts every utility inside a
    // cascade @layer, which loses to the iframe's unlayered UA/Sandpack styles —
    // the cause of the "serif, no colors" preview. Importing preflight + theme +
    // utilities unlayered makes every rule apply at normal priority.
    //   - theme.css   → design tokens (@theme) + our overrides
    //   - preflight.css → the base reset (sans font, margin:0, etc.)
    //   - utilities.css → the actual utility classes, scanned from our sources
    const sources = sourceNames.map((n) => `@source "${join(dir!, n)}";`).join("\n");
    const entry = [
      `@import "tailwindcss/theme.css" source(none);`,
      `@import "tailwindcss/preflight.css";`,
      `@import "tailwindcss/utilities.css" source(none);`,
      sources,
      THEME,
      "",
    ].join("\n");
    const inPath = join(dir, "in.css");
    const outPath = join(dir, "out.css");
    await writeFile(inPath, entry, "utf8");

    // Run `node <cli-entry> -i in.css -o out.css --minify`. Passing argv as an
    // array (execFile, no shell) means spaces in paths need no quoting and there
    // is no cmd.exe/.bin-extension issue on Windows.
    await run(process.execPath, [cliEntry(), "-i", inPath, "-o", outPath, "--minify"], {
      cwd: process.cwd(),
      timeout: COMPILE_TIMEOUT_MS,
    });

    const css = await readFile(outPath, "utf8");
    return css.trim() || null;
  } catch (err) {
    console.warn(`[tailwind] compile failed, sandbox will use the CDN fallback: ${(err as Error).message}`);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}