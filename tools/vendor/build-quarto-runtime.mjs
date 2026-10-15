// Packs the parts of the local Quarto installation that run inside pandoc
// into `quarto-runtime.json`, so the browser can call pandoc-wasm exactly
// the way `quarto render` calls pandoc.
//
// Quarto's TypeScript generates some inputs per render (a patched template,
// filter parameters, include files). Rather than re-implement that, this
// script renders a small document with a logging stand-in for pandoc
// (QUARTO_PANDOC) and captures what Quarto passed. Re-run it after upgrading
// Quarto:  npm run build-quarto-runtime
//
// Quarto's filters target a specific pandoc version, which must match the
// pandoc-wasm build the browser loads (pandoc-wasm 1.1.0 is pandoc 3.10, as
// used by Quarto 1.10). To build from a Quarto that isn't on your PATH:
//   QUARTO=/path/to/quarto/bin/quarto npm run build-quarto-runtime

import { execFileSync } from "node:child_process"
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, relative } from "node:path"
import jsyaml from "js-yaml"
import { buildSync } from "esbuild"

const OUT_DIR = new URL("../../_extensions/quarto-simulator/resources/", import.meta.url).pathname
const VSHARE = "/quarto/share"
const VSESSION = "/quarto/session"

const QUARTO = process.env.QUARTO || "quarto"
const [binPath, sharePath] = execFileSync(QUARTO, ["--paths"], { encoding: "utf8" }).trim().split("\n")
const version = execFileSync(QUARTO, ["--version"], { encoding: "utf8" }).trim()
const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
const realPandoc = join(binPath, "tools", arch, "pandoc")
const pandocVersion = execFileSync(realPandoc, ["--version"], { encoding: "utf8" }).split("\n")[0]
console.log(`Quarto ${version} at ${sharePath} (${pandocVersion})`)

// 1. Render a capture document through a logging pandoc wrapper. ------------------

const work = mkdtempSync(join(tmpdir(), "quarto-simulator-capture-"))
const captureDir = join(work, "capture")
writeFileSync(join(work, "wrapper.sh"), `#!/bin/bash
mkdir -p "${captureDir}"
printf '%s\\n' "$@" > "${captureDir}/args.txt"
env > "${captureDir}/env.txt"
for a in "$@"; do case "$a" in */quarto-defaults*.yml) cp -R "$(dirname "$a")" "${captureDir}/session" ;; esac; done
exec "${realPandoc}" "$@"
`)
chmodSync(join(work, "wrapper.sh"), 0o755)
writeFileSync(join(work, "capture.qmd"), "---\ntitle: Capture\nengine: markdown\n---\n\nHello.\n")
execFileSync(QUARTO, ["render", "capture.qmd", "--to", "html"], {
  cwd: work,
  env: { ...process.env, QUARTO_PANDOC: join(work, "wrapper.sh") },
  stdio: "inherit"
})

const env = Object.fromEntries(
  readFileSync(join(captureDir, "env.txt"), "utf8").trim().split("\n")
    .filter(l => l.startsWith("QUARTO_"))
    .map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
)
const sessionDir = dirname(env.QUARTO_FILTER_DEPENDENCY_FILE)
const session = join(captureDir, "session")
const sessionFiles = readdirSync(session)
const defaultsFile = sessionFiles.find(f => f.startsWith("quarto-defaults"))
const metadataFile = sessionFiles.find(f => f.startsWith("quarto-metadata"))

// Paths in the captured inputs point at the real installation and temp dir;
// map them onto the virtual file system.
const remap = text => text.replaceAll(sessionDir, VSESSION).replaceAll(sharePath, VSHARE)

// 2. Collect files. ----------------------------------------------------------------

const files = {}
const add = (vpath, localPath) => { files[vpath] = readFileSync(localPath, "utf8") }
const walk = (dir, filter, visit) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, filter, visit)
    else if (filter(p)) visit(p)
  }
}

walk(join(sharePath, "filters"), p => p.endsWith(".lua"), p => add(`${VSHARE}/${relative(sharePath, p)}`, p))
for (const ext of ["kbd", "video", "lipsum", "version", "placeholder"]) {
  const dir = join(sharePath, "extensions", "quarto", ext)
  for (const name of readdirSync(dir)) {
    if (name.endsWith(".lua")) add(`${VSHARE}/extensions/quarto/${ext}/${name}`, join(dir, name))
  }
}
// The code Quarto runs in a Python kernel before a document's cells.
add(`${VSHARE}/jupyter/lang/python/setup.py`, join(sharePath, "jupyter", "lang", "python", "setup.py"))
const datadir = join(sharePath, "pandoc", "datadir")
for (const name of readdirSync(datadir)) {
  if (!name.endsWith(".lua") || name.startsWith("luacov")) continue
  add(`${VSHARE}/pandoc/datadir/${name}`, join(datadir, name))
}

const defaults = jsyaml.load(remap(readFileSync(join(session, defaultsFile), "utf8")))
// Any installation file the defaults point at (highlighting theme, syntax
// definitions); the option names vary between pandoc versions.
const sharePaths = value => typeof value === "string" ? (value.startsWith(VSHARE + "/") ? [value] : [])
  : Array.isArray(value) ? value.flatMap(sharePaths) : []
for (const [key, value] of Object.entries(defaults)) {
  if (key === "filters" || key === "from") continue
  for (const p of sharePaths(value)) add(p, join(sharePath, p.slice(VSHARE.length + 1)))
}
// pandoc finds a highlighter for an `r` code block by name, and failing
// that by file extension, which decodes every built-in syntax definition
// (about a second in wasm, on every render). Naming Quarto's R definition
// "r" makes the lookup direct; the highlighting rules are unchanged.
const rSyntax = `${VSHARE}/pandoc/syntax-definitions/r.xml`
if (files[rSyntax]) {
  files[rSyntax] = files[rSyntax].replace(/(<language\b[^>]*\bname=")R Script"/, '$1r"')
  if (!files[rSyntax].includes('name="r"')) throw new Error("Could not rename the R syntax definition")
}
// Remaining session files: the patched template and its partials, include
// files and the (empty) notebook context.
// The dependency file is output the capture render wrote, not an input.
const renderOutputs = new Set([basename(env.QUARTO_FILTER_DEPENDENCY_FILE)])
walk(session, p => !/quarto-(defaults|metadata|input)/.test(basename(p)) && !renderOutputs.has(basename(p)), p => {
  files[`${VSESSION}/${relative(session, p)}`] = remap(readFileSync(p, "utf8"))
})

// 3. Base inputs, with per-document values removed. --------------------------------

delete defaults["output-file"]
const metadata = jsyaml.load(readFileSync(join(session, metadataFile), "utf8"))
delete metadata.title
const params = JSON.parse(remap(Buffer.from(env.QUARTO_FILTER_PARAMS, "base64").toString("utf8")))
delete params["quarto-source"]
// Values describing the build machine rather than the document. The browser
// has none of these tools, and they would leak local paths.
params["quarto-cli-path"] = "/quarto/bin/quarto"
params["quarto-environment"] = { paths: {} }
params["notebook-context"] = `${VSESSION}/notebook-context.json`
files[params["notebook-context"]] = "[]"

// 4. HTML dependencies from the rendered page. ---------------------------------------

const html = readFileSync(join(work, "capture.html"), "utf8")
const head = html.slice(html.indexOf("<head>"), html.indexOf("</head>"))
// The preview iframe is sandboxed (opaque origin), and browsers only load
// module scripts from it with CORS headers. quarto.js and the tabsets module
// it imports are therefore bundled into one classic, deferred script.
const headTags = head.match(/<(script|link)[^>]*(src|href)="capture_files\/libs\/[^"]*"[^>]*>(<\/script>)?/g)
  .filter(tag => !tag.includes("axe-check") && !tag.includes("tabsets/tabsets.js"))
  .map(tag => tag.replace(/capture_files\/libs\//, "{{LIBS}}"))
  .map(tag => tag.includes("quarto-html/quarto.js") ? tag.replace(' type="module"', " defer") : tag)
const libsOut = join(OUT_DIR, "quarto-libs")
rmSync(libsOut, { recursive: true, force: true })
cpSync(join(work, "capture_files", "libs"), libsOut, { recursive: true })
rmSync(join(libsOut, "quarto-html", "axe"), { recursive: true, force: true })
// quarto.js imports the accessibility checker; it is only used in dev mode.
const quartoJs = join(libsOut, "quarto-html", "quarto.js")
writeFileSync(quartoJs, readFileSync(quartoJs, "utf8")
  .replace(/^import \* as axe from .*$/m, "const axe = { init() {} };"))

buildSync({ entryPoints: [quartoJs], bundle: true, format: "iife", outfile: quartoJs, allowOverwrite: true, logLevel: "warning" })
rmSync(join(libsOut, "quarto-html", "tabsets"), { recursive: true, force: true })

const libFiles = []
walk(libsOut, () => true, p => libFiles.push(relative(libsOut, p)))

// The lesson-time filter ships these files as HTML dependency resources.
writeFileSync(join(OUT_DIR, "quarto-libs.lua"),
  "-- Generated by tools/vendor/build-quarto-runtime.mjs\nreturn " +
  JSON.stringify(libFiles).replace("[", "{").replace(/\]$/, "}") + "\n")

// How Quarto's CLI sorts top-level options (metadataAsFormat): keys in these
// groups configure rendering; everything else becomes document metadata.
// Read from the CLI bundle so the lists follow the Quarto version.
const cli = readFileSync(join(binPath, "quarto.js"), "utf8")
const constants = {}
for (const [, name, value] of cli.matchAll(/\b(k[A-Za-z0-9]+) = "([^"]*)";/g)) constants[name] ??= value
const optionGroups = {}
for (const group of ["Identifier", "Execute", "Render", "Pandoc", "Language"]) {
  const body = cli.match(new RegExp(`\\bk${group}DefaultsKeys = \\[([\\s\\S]*?)\\];`))?.[1]
  if (!body) throw new Error(`k${group}DefaultsKeys not found in quarto.js`)
  // Entries are constants (kToc) or string literals ("css").
  const resolve = n => /^"[^"]*"$/.test(n) ? n.slice(1, -1) : constants[n]
  const names = body.split(",").map(n => n.trim()).filter(Boolean)
  const missing = names.filter(n => resolve(n) === undefined)
  if (missing.length) throw new Error(`Unresolved option constants: ${missing.join(", ")}`)
  optionGroups[group.toLowerCase()] = names.map(resolve)
}

const bundle = { quartoVersion: version, pandocVersion, optionGroups, defaults, metadata, params, headTags, libFiles, files }
// Refuse to ship anything that still points into the build machine.
const json = JSON.stringify(bundle)
const leaks = [...new Set(json.match(/(\/Users\/|\/home\/|\/private\/|\/var\/folders\/|[A-Z]:\\\\)[^"\\]{0,60}/g) || [])]
if (leaks.length) throw new Error(`Local paths in the runtime bundle:\n  ${leaks.join("\n  ")}`)
writeFileSync(join(OUT_DIR, "quarto-runtime.json"), json)
rmSync(work, { recursive: true, force: true })

const size = Object.values(files).reduce((n, s) => n + s.length, 0)
console.log(`Wrote quarto-runtime.json: ${Object.keys(files).length} files, ${(size / 1e6).toFixed(2)} MB`)
console.log(`Copied ${libFiles.length} HTML dependency files to quarto-libs/`)
