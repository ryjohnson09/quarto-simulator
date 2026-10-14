// Runs pandoc.wasm the way `quarto render` runs pandoc for HTML: as a
// command-line program, with Quarto's own reader, Lua filters, data directory
// and template from the bundle build-quarto-runtime.mjs captures from a real
// Quarto installation.
//
// pandoc.wasm is a WASI command, so each render starts a fresh instance with
// its arguments, environment and file system, much as Quarto spawns a pandoc
// process. Only the compiled module is reused between renders.

import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim"

const SESSION = "/quarto/session"
const DATADIR = "/quarto/share/pandoc/datadir"

export async function createQuartoPandoc(wasmBinary, bundle) {
  const module = await WebAssembly.compile(wasmBinary)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  // The virtual file system persists between renders; each render rewrites
  // its session files.
  const root = new Map()
  function writeFile(path, text) {
    const parts = path.split("/").filter(Boolean)
    const name = parts.pop()
    let dir = root
    for (const part of parts) {
      if (!dir.has(part)) dir.set(part, new Directory(new Map()))
      dir = dir.get(part).contents
    }
    dir.set(name, new File(encoder.encode(text)))
  }
  function readFile(path) {
    let entry = { contents: root }
    for (const part of path.split("/").filter(Boolean)) entry = entry?.contents?.get(part)
    return entry?.data ? decoder.decode(entry.data) : ""
  }
  for (const [path, text] of Object.entries(bundle.files)) writeFile(path, text)

  // Quarto passes filter parameters as base64-encoded UTF-8 JSON.
  function base64(text) {
    let binary = ""
    for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  // markdown: the document body (front matter removed, cells executed)
  // metadata: document metadata, merged over Quarto's format defaults
  // defaults: pandoc options such as toc / toc-depth
  // params:   Quarto filter parameters such as code-fold / number-sections
  async function render({ markdown, metadata = {}, defaults = {}, params = {} }) {
    writeFile(`${SESSION}/input.md`, markdown)
    writeFile(`${SESSION}/metadata.json`, JSON.stringify({ ...bundle.metadata, ...metadata }))
    writeFile(`${SESSION}/dependencies`, "")
    writeFile(`${SESSION}/results`, "")
    // JSON is valid YAML, so it can serve as a pandoc defaults file.
    writeFile(`${SESSION}/defaults.yaml`, JSON.stringify({
      ...bundle.defaults,
      ...defaults,
      "data-dir": DATADIR,
      "input-files": [`${SESSION}/input.md`],
      "metadata-files": [`${SESSION}/metadata.json`]
    }))

    const env = {
      QUARTO_FILTER_PARAMS: base64(JSON.stringify({
        ...bundle.params,
        ...params,
        "quarto-source": "document.qmd",
        "results-file": `${SESSION}/results`
      })),
      QUARTO_FILTER_DEPENDENCY_FILE: `${SESSION}/dependencies`,
      QUARTO_SHARE_PATH: "/quarto/share",
      QUARTO_DOCUMENT_PATH: SESSION,
      QUARTO_DOCUMENT_FILE: "document.qmd",
      QUARTO_PROJECT_ROOT: SESSION,
      QUARTO_ROOT: "/",
      LUA_PATH: `${DATADIR}/?.lua;;`
    }

    const stdout = []
    const stderr = []
    const wasi = new WASI(
      ["pandoc", "--defaults", `${SESSION}/defaults.yaml`],
      Object.entries(env).map(([name, value]) => `${name}=${value}`),
      [
        new OpenFile(new File(new Uint8Array())),
        new ConsoleStdout(bytes => stdout.push(bytes.slice())),
        ConsoleStdout.lineBuffered(line => stderr.push(line)),
        new PreopenDirectory("/", root)
      ],
      { debug: false }
    )
    const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport })
    const exitCode = wasi.start(instance)

    const html = new Uint8Array(stdout.reduce((n, bytes) => n + bytes.length, 0))
    stdout.reduce((offset, bytes) => (html.set(bytes, offset), offset + bytes.length), 0)
    return {
      html: decoder.decode(html),
      stderr,
      exitCode,
      dependencies: readFile(`${SESSION}/dependencies`)
    }
  }

  return { render, quartoVersion: bundle.quartoVersion }
}
