// Runs pandoc-wasm the way `quarto render` runs pandoc for HTML: Quarto's
// own reader, Lua filters, data directory and template, from the bundle that
// build-quarto-runtime.mjs captures from a real Quarto installation.
//
// Adapted from pandoc-wasm's src/core.js, which only supports a flat,
// read-only file system; Quarto's filters need nested directories and
// writable files.

import { ConsoleStdout, Directory, File, OpenFile, PreopenDirectory, WASI } from "@bjorn3/browser_wasi_shim"

const SESSION = "/quarto/session"

async function instantiate(wasmBinary, log) {
  const args = ["pandoc.wasm", "+RTS", "-H64m", "-RTS"]
  const root = new Map()
  const fds = [
    new OpenFile(new File(new Uint8Array(), { readonly: true })),
    ConsoleStdout.lineBuffered(msg => log.push(msg)),
    ConsoleStdout.lineBuffered(msg => log.push(msg)),
    new PreopenDirectory("/", root)
  ]
  const wasi = new WASI(args, [], fds, { debug: false })
  const { instance } = await WebAssembly.instantiate(wasmBinary, { wasi_snapshot_preview1: wasi.wasiImport })
  wasi.initialize(instance)
  instance.exports.__wasm_call_ctors()

  const view = () => new DataView(instance.exports.memory.buffer)
  const cString = s => {
    const bytes = new TextEncoder().encode(s)
    const ptr = instance.exports.malloc(bytes.length + 1)
    new Uint8Array(instance.exports.memory.buffer, ptr, bytes.length).set(bytes)
    view().setUint8(ptr + bytes.length, 0)
    return ptr
  }
  const argc = instance.exports.malloc(4)
  view().setUint32(argc, args.length, true)
  const argv = instance.exports.malloc(4 * (args.length + 1))
  args.forEach((a, i) => view().setUint32(argv + 4 * i, cString(a), true))
  view().setUint32(argv + 4 * args.length, 0, true)
  const argvPtr = instance.exports.malloc(4)
  view().setUint32(argvPtr, argv, true)
  instance.exports.hs_init_with_rtsopts(argc, argvPtr)

  return { instance, root }
}

export async function createQuartoPandoc(wasmBinary, bundle) {
  // Quarto's Lua filters report warnings by writing to stderr.
  const log = []
  const { instance, root } = await instantiate(wasmBinary, log)
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  function directory(parts) {
    let map = root
    for (const part of parts) {
      if (!map.has(part)) map.set(part, new Directory(new Map()))
      map = map.get(part).contents
    }
    return map
  }
  function writeFile(path, text) {
    const parts = path.split("/").filter(Boolean)
    const name = parts.pop()
    directory(parts).set(name, new File(encoder.encode(text), { readonly: false }))
  }
  function readFile(path) {
    const parts = path.split("/").filter(Boolean)
    const name = parts.pop()
    const file = directory(parts).get(name)
    return file ? decoder.decode(file.data) : ""
  }

  for (const [path, text] of Object.entries(bundle.files)) writeFile(path, text)

  // UTF-8 safe base64, as Quarto passes QUARTO_FILTER_PARAMS.
  function base64(text) {
    let binary = ""
    for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  // markdown: the document body (front matter removed, cells executed)
  // metadata: document metadata, merged over Quarto's format defaults
  // defaults: pandoc options such as toc / toc-depth
  // params:   Quarto filter parameters such as code-fold / number-sections
  function render({ markdown, metadata = {}, defaults = {}, params = {} }) {
    writeFile(`${SESSION}/input.md`, markdown)
    writeFile(`${SESSION}/metadata.json`, JSON.stringify({ ...bundle.metadata, ...metadata }))
    writeFile(`${SESSION}/dependencies`, "")
    writeFile(`${SESSION}/results`, "")
    writeFile("/quarto-env.json", JSON.stringify({
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
      QUARTO_ROOT: "/"
    }))
    log.length = 0
    for (const name of ["stdin", "stdout", "stderr", "warnings"]) {
      root.set(name, new File(new Uint8Array(), { readonly: false }))
    }

    const options = encoder.encode(JSON.stringify({
      ...bundle.defaults,
      ...defaults,
      "data-dir": "/quarto/share/pandoc/datadir",
      "input-files": [`${SESSION}/input.md`],
      "metadata-files": [`${SESSION}/metadata.json`]
    }))
    const ptr = instance.exports.malloc(options.length)
    new Uint8Array(instance.exports.memory.buffer, ptr, options.length).set(options)
    instance.exports.convert(ptr, options.length)

    let warnings = []
    try {
      warnings = JSON.parse(decoder.decode(root.get("warnings").data) || "[]")
    } catch {}
    return {
      html: decoder.decode(root.get("stdout").data),
      stderr: decoder.decode(root.get("stderr").data),
      warnings,
      log: log.slice(),
      dependencies: readFile(`${SESSION}/dependencies`)
    }
  }

  return { render, quartoVersion: bundle.quartoVersion }
}
