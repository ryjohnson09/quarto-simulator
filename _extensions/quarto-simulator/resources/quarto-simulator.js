// quarto-simulator: write and render Quarto documents inside a Quarto document.
//
// Rendering follows `quarto render` for HTML, entirely in the browser:
//   1. Parse the YAML front matter (js-yaml) and resolve Quarto options, as
//      Quarto's command-line tool does before it calls pandoc.
//   2. Execute R cells with webR, producing the same intermediate markdown
//      that knitr hands to pandoc (`::: {.cell}` divs, outputs, figures).
//   3. Run pandoc-wasm with Quarto's own reader, Lua filters, data directory
//      and template (captured from a real installation into
//      quarto-runtime.json by tools/vendor/build-quarto-runtime.mjs).
//   4. Apply Quarto's HTML post-processing and show the page in a sandboxed
//      iframe with Quarto's own CSS and JavaScript.

import { createEditor, setEditorText, jsyaml, createQuartoPandoc, postprocess } from "./vendor.js"

const asset = name => new URL(name, import.meta.url).href

const settings = {
  pandocWasmUrl: "https://unpkg.com/pandoc-wasm@1.1.0/src/pandoc.wasm",
  webrUrl: "https://webr.r-wasm.org/v0.6.0/webr.mjs",
  mermaidUrl: "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js",
  ...readJson(document.getElementById("quarto-simulator-settings"))
}

function readJson(el) {
  return el ? JSON.parse(el.textContent) : {}
}

// Engines ----------------------------------------------------------------------
// Shared by every playground on the page and loaded on first use.

let quartoPromise
function loadQuarto() {
  quartoPromise ??= (async () => {
    const [wasm, bundle] = await Promise.all([
      fetchOk(settings.pandocWasmUrl).then(r => r.arrayBuffer()),
      fetchOk(asset("quarto-runtime.json")).then(r => r.json())
    ])
    const quarto = await createQuartoPandoc(wasm, bundle)
    return { ...quarto, bundle }
  })()
  quartoPromise.catch(() => (quartoPromise = undefined))
  return quartoPromise
}

async function fetchOk(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status})`)
  return response
}

// R helpers installed into the webR session. Evaluation follows knitr's
// conventions: one source block per top-level expression, output captured in
// order, conditions formatted as knitr prints them, and a plot shown after the
// last expression that changed it.
const R_HELPERS = String.raw`
.qp <- new.env()
.qp$page <- 0L
setHook("before.plot.new", function() if (isTRUE(par("page"))) .qp$page <- .qp$page + 1L)
setHook("before.grid.newpage", function() .qp$page <- .qp$page + 1L)

.qp$split <- function(code) {
  refs <- attr(parse(text = code, keep.source = TRUE), "srcref")
  as.integer(vapply(refs, function(r) r[[3]], 0))
}

.qp$condition_text <- function(prefix, cnd) {
  call <- conditionCall(cnd)
  msg <- conditionMessage(cnd)
  if (is.null(call) || identical(call[[1]], quote(eval))) {
    paste0(prefix, ": ", msg)
  } else {
    paste0(prefix, " in ", deparse(call, nlines = 1L), ": ", msg)
  }
}

.qp$eval_one <- function(src, env, warning, message) {
  out <- character()
  failed <- FALSE
  qp_text <- character()
  tc <- textConnection("qp_text", "w", local = TRUE)
  sink(tc)
  seen <- 0L
  flush <- function() {
    txt <- textConnectionValue(tc)
    if (length(txt) > seen) {
      out <<- c(out, "stdout", paste(txt[(seen + 1L):length(txt)], collapse = "\n"))
      seen <<- length(txt)
    }
  }
  tryCatch(
    withCallingHandlers({
      exprs <- parse(text = src)
      if (length(exprs)) {
        vis <- withVisible(eval(exprs, env))
        if (vis$visible) print(vis$value)
      }
    },
    warning = function(w) {
      flush()
      if (warning) out <<- c(out, "stderr", .qp$condition_text("Warning", w))
      invokeRestart("muffleWarning")
    },
    message = function(m) {
      flush()
      if (message) out <<- c(out, "stderr", sub("\n$", "", conditionMessage(m)))
      invokeRestart("muffleMessage")
    }),
    error = function(e) {
      flush()
      out <<- c(out, "error", .qp$condition_text("Error", e))
      failed <<- TRUE
    }
  )
  sink()
  close(tc)
  if (length(qp_text) > seen) {
    out <- c(out, "stdout", paste(qp_text[(seen + 1L):length(qp_text)], collapse = "\n"))
  }
  list(out = out, failed = failed)
}

.qp$run_cell <- function(srcs, env, warning = TRUE, message = TRUE, error = FALSE) {
  dev.control("enable")
  .qp$page <- 0L
  last <- NULL
  out <- character()
  for (src in srcs) {
    out <- c(out, "source", src)
    res <- .qp$eval_one(src, env, warning, message)
    out <- c(out, res$out)
    dl <- tryCatch(recordPlot()[[1]], error = function(e) NULL)
    if (length(dl) && !identical(dl, last)) out <- c(out, "plot", as.character(.qp$page))
    last <- dl
    if (res$failed && !error) break
  }
  out
}

.qp$inline <- function(src, env) {
  value <- eval(parse(text = src), env)
  paste(format(value), collapse = ", ")
}
`

const BASE_R_PACKAGES = new Set([
  "base", "compiler", "datasets", "graphics", "grDevices", "grid", "methods",
  "parallel", "splines", "stats", "stats4", "tcltk", "tools", "utils", "webr"
])

let webRPromise
function loadWebR() {
  webRPromise ??= (async () => {
    const { WebR } = await import(settings.webrUrl)
    const webR = new WebR()
    await webR.init()
    await webR.evalRVoid(R_HELPERS)
    return { webR, installed: new Set() }
  })()
  webRPromise.catch(() => (webRPromise = undefined))
  return webRPromise
}

// webR runs one evaluation at a time and every render uses a fresh
// environment, so renders from different playgrounds take turns.
let rQueue = Promise.resolve()
function withR(task) {
  const run = rQueue.then(task)
  rQueue = run.catch(() => {})
  return run
}

// Parsing the document ----------------------------------------------------------------

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/
const EXECUTABLE = /^\{([A-Za-z][\w-]*)(.*)\}\s*$/
const LITERAL_CELL = /^\{\{([A-Za-z][\w-]*.*)\}\}\s*$/

class RenderError extends Error {
  constructor(message, detail) {
    super(message)
    this.detail = detail
  }
}

function parseFrontMatter(source) {
  const match = source.match(FRONT_MATTER)
  if (!match) return { yaml: {}, bodyStart: 0 }
  let yaml
  try {
    // The leading newline stands in for the opening `---`, so js-yaml's line
    // numbers match the editor's.
    yaml = jsyaml.load("\n" + match[1]) ?? {}
  } catch (err) {
    const line = err.mark ? err.mark.line + 1 : null
    const col = err.mark ? err.mark.column + 1 : null
    let detail = err.mark?.snippet
    // js-yaml reports an unclosed quote where the YAML ends; point at the quote.
    const quote = /double quoted/.test(err.reason) ? '"' : /single quoted/.test(err.reason) ? "'" : null
    if (quote) {
      const opened = match[1].split("\n").findIndex(l => (l.split(quote).length - 1) % 2 === 1)
      if (opened >= 0) detail = `Hint: the ${quote} quote on line ${opened + 2} is never closed.\n\n${detail}`
    }
    throw new RenderError(`YAML error${line ? ` (line ${line}, column ${col})` : ""}: ${err.reason || err.message}`, detail)
  }
  if (typeof yaml !== "object" || Array.isArray(yaml)) {
    throw new RenderError("YAML error: the front matter must be a set of `key: value` pairs.")
  }
  return { yaml, bodyStart: match[0].length }
}

// Splits the body into markdown text and executable cells, the way Quarto's
// engines find cells: a fence whose info string is `{lang ...}`.
function splitCells(body, firstLine) {
  const lines = body.split(/\r?\n/)
  const parts = []
  let text = []
  let i = 0
  const pushText = () => {
    if (text.length) parts.push({ type: "markdown", text: text.join("\n") })
    text = []
  }
  while (i < lines.length) {
    const fence = lines[i].match(FENCE)
    if (!fence) {
      text.push(lines[i++])
      continue
    }
    const [, indent, marker, info] = fence
    const closing = new RegExp(`^\\s*${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`)
    let end = i + 1
    while (end < lines.length && !closing.test(lines[end])) end++
    const inner = lines.slice(i + 1, end)
    const exec = info.trim().match(EXECUTABLE)
    const literal = info.trim().match(LITERAL_CELL)
    if (exec && marker[0] === "`") {
      pushText()
      parts.push({
        type: "cell",
        lang: exec[1].toLowerCase(),
        header: exec[2],
        lines: inner,
        startLine: firstLine + i,
        endLine: firstLine + Math.min(end, lines.length - 1)
      })
    } else {
      // Plain code blocks are kept apart so inline `{r}` is not evaluated inside them.
      pushText()
      let verbatim = lines.slice(i, end + 1)
      if (literal) {
        // ```{{r}} shows a cell verbatim, fences and all.
        const outer = "`".repeat(Math.max(4, marker.length + 1))
        verbatim = [`${indent}${outer}markdown`, `${indent}${marker}{${literal[1]}}`, ...inner, `${indent}${marker}`, `${indent}${outer}`]
      }
      parts.push({ type: "verbatim", text: verbatim.join("\n") })
    }
    i = end + 1
  }
  pushText()
  return parts
}

// `#| key: value` lines at the top of a cell, plus knitr-style
// `{r label, echo=FALSE}` header options.
function parseCellOptions(cell) {
  let n = 0
  while (n < cell.lines.length && /^\s*#\|/.test(cell.lines[n])) n++
  const yamlText = cell.lines.slice(0, n).map(l => l.replace(/^\s*#\|\s?/, "")).join("\n")
  let options = {}
  try {
    options = jsyaml.load(yamlText) ?? {}
  } catch (err) {
    throw new RenderError(
      `Invalid cell option on line ${cell.startLine + 1 + (err.mark?.line ?? 0)}: ${err.reason || err.message}`,
      err.mark?.snippet
    )
  }
  const header = cell.header.replace(/^[\s,]+/, "")
  for (const [index, part] of header.split(",").map(s => s.trim()).filter(Boolean).entries()) {
    const kv = part.match(/^([\w.-]+)\s*=\s*(.+)$/)
    if (kv) {
      const value = kv[2].trim()
      options[kv[1].replace(/\./g, "-")] =
        value === "TRUE" ? true : value === "FALSE" ? false : value.replace(/^["']|["']$/g, "")
    } else if (index === 0 && options.label === undefined) {
      options.label = part
    }
  }
  return { options, code: cell.lines.slice(n).join("\n") }
}

// Quarto options for HTML: top-level keys, overridden by `format: html:`.
function resolveFormat(yaml, notices) {
  const format = yaml.format
  let html = {}
  if (typeof format === "string") {
    if (format !== "html") {
      notices.push(`This document's format is \`${format}\`. The playground only previews HTML, so you're seeing \`html\` output instead.`)
    }
  } else if (format && typeof format === "object") {
    const names = Object.keys(format)
    if (!names.includes("html")) {
      notices.push(`This document's format is \`${names.join("`, `")}\`. The playground only previews HTML, so you're seeing \`html\` output instead.`)
    } else if (names.length > 1) {
      notices.push(`Showing the \`html\` format. Other formats (\`${names.filter(n => n !== "html").join("`, `")}\`) can't be previewed here.`)
    }
    if (format.html && typeof format.html === "object") html = format.html
  }
  const options = { ...yaml, ...html }
  if (options.theme) {
    notices.push("The playground always uses Quarto's default theme, so `theme` has no visible effect here.")
  }
  return options
}

const KNOWN_KEYS = [
  "title", "subtitle", "author", "date", "abstract", "format", "toc", "toc-title",
  "toc-depth", "number-sections", "code-fold", "code-summary", "execute", "theme",
  "fig-width", "fig-height", "fig-cap-location", "bibliography", "editor", "jupyter",
  "engine", "lang", "description", "categories", "keywords", "date-format"
]

function lintKeys(yaml, notices) {
  for (const key of Object.keys(yaml)) {
    if (KNOWN_KEYS.includes(key)) continue
    const guess = KNOWN_KEYS.find(k => editDistance(k, key) <= 2 && k.length > 3)
    if (guess) notices.push(`Unknown option \`${key}\`. Did you mean \`${guess}\`?`)
  }
}

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
  }
  return d[a.length][b.length]
}

function formatDate(value) {
  let date
  if (value instanceof Date) {
    date = new Date(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
  } else if (value === "today" || value === "now" || value === "last-modified") {
    date = new Date()
  } else if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-").map(Number)
    date = new Date(y, m - 1, d)
  } else {
    return value == null ? "" : String(value)
  }
  return date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
}

// Executing cells -----------------------------------------------------------------------

const DEFAULT_CELL_OPTIONS = {
  echo: true, eval: true, include: true, output: true, warning: true, message: true, error: false
}

function fenceFor(text, char = "`") {
  const longest = Math.max(2, ...(text.match(new RegExp(`${char}{3,}`, "g")) || []).map(s => s.length))
  return char.repeat(longest + 1)
}

function codeBlock(code, classes) {
  const fence = fenceFor(code)
  return `${fence} {${classes}}\n${code}\n${fence}`
}

function outputBlock(kind, text) {
  const fence = fenceFor(text)
  return `::: {.cell-output .cell-output-${kind}}\n\n${fence}\n${text}\n${fence}\n\n:::`
}

function packagesUsed(code) {
  const found = new Set()
  for (const m of code.matchAll(/\b(?:library|require|requireNamespace)\(\s*["']?([A-Za-z][\w.]*)["']?/g)) found.add(m[1])
  for (const m of code.matchAll(/\b([A-Za-z][\w.]*):::?/g)) found.add(m[1])
  return [...found].filter(p => !BASE_R_PACKAGES.has(p))
}

async function ensurePackages(r, packages, setStatus) {
  for (const pkg of packages) {
    if (r.installed.has(pkg)) continue
    const have = await r.webR.evalRBoolean(`requireNamespace("${pkg}", quietly = TRUE)`)
    if (!have) {
      setStatus(`Installing R package ${pkg}…`)
      await r.webR.installPackages([pkg], { quiet: true })
    }
    r.installed.add(pkg)
  }
}

async function bitmapToDataUrl(bitmap) {
  const canvas = document.createElement("canvas")
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext("2d").drawImage(bitmap, 0, 0)
  return canvas.toDataURL("image/png")
}

// Attributes Quarto's knitr hooks (share/rmd/hooks.R) write on the cell div
// and code blocks; Quarto's Lua filters act on them.
const quote = value => `"${String(value).replace(/"/g, "&quot;")}"`

function cellDivAttributes(options) {
  const classes = [".cell"]
  for (const cls of [].concat(options.classes ?? [])) classes.push(cls.startsWith(".") ? cls : `.${cls}`)
  const prefixed = { panel: "panel-", column: "column-", "fig-column": "fig-column-", "tbl-column": "tbl-column-",
    "cap-location": "caption-", "fig-cap-location": "fig-cap-location-", "tbl-cap-location": "tbl-cap-location-" }
  for (const [option, prefix] of Object.entries(prefixed)) {
    if (typeof options[option] === "string") classes.push(`.${prefix}${options[option]}`)
  }
  const attrs = []
  if (typeof options.label === "string" && options.label.startsWith("tbl-")) attrs.push(`#${options.label}`)
  attrs.push(...classes)
  for (const option of ["layout", "layout-nrow", "layout-ncol", "layout-align", "layout-valign"]) {
    if (options[option] != null) {
      attrs.push(`${option}=${quote(typeof options[option] === "string" ? options[option] : JSON.stringify(options[option]))}`)
    }
  }
  return attrs.join(" ")
}

function codeBlockAttributes(options) {
  const attrs = [".cell-code"]
  if (options["code-overflow"] === "wrap") attrs.push(".code-overflow-wrap")
  if (options["code-overflow"] === "scroll") attrs.push(".code-overflow-scroll")
  if (options["code-fold"] != null) attrs.push(`code-fold=${quote(String(options["code-fold"]).toLowerCase())}`)
  if (options["code-summary"] != null) attrs.push(`code-summary=${quote(options["code-summary"])}`)
  if (options["code-line-numbers"] != null) attrs.push(`code-line-numbers=${quote(String(options["code-line-numbers"]).toLowerCase())}`)
  return attrs.join(" ")
}

// Runs one R cell and returns the markdown knitr would have produced.
async function runRCell(r, cell, options, docOptions, images, cellIndex) {
  const { code } = cell
  const sources = []
  const lines = code.split("\n")
  let lastLines
  try {
    const result = await r.webR.evalR(`.qp$split(${JSON.stringify(code)})`)
    lastLines = [...new Set(await result.toArray())].sort((a, b) => a - b)
  } catch (err) {
    throw new RenderError(`Error in R cell ${cellIndex} (lines ${cell.startLine + 1}–${cell.endLine + 1}): the code could not be parsed.`, String(err.message || err).replace(/^Error: /, ""))
  }
  let start = 0
  lastLines.forEach((end, i) => {
    const stop = i === lastLines.length - 1 ? lines.length : end
    sources.push(lines.slice(start, stop).join("\n").replace(/^\n+|\s+$/g, ""))
    start = stop
  })
  if (sources.length === 0) sources.push(code.replace(/\s+$/, ""))

  let events = sources.map(text => ({ type: "source", text }))
  let pageImages = []
  if (options.eval) {
    const width = Number(options["fig-width"] ?? docOptions["fig-width"] ?? 7)
    const height = Number(options["fig-height"] ?? docOptions["fig-height"] ?? 5)
    const shelter = await new r.webR.Shelter()
    try {
      await r.webR.objs.globalEnv.bind(".qp_srcs", sources)
      const result = await shelter.captureR(
        `.qp$run_cell(.qp_srcs, .qp_env, warning = ${options.warning ? "TRUE" : "FALSE"}, ` +
          `message = ${options.message ? "TRUE" : "FALSE"}, error = ${options.error ? "TRUE" : "FALSE"})`,
        { captureGraphics: { width: width * 72, height: height * 72, bg: "white" } }
      )
      const flat = await result.result.toArray()
      events = []
      for (let i = 0; i < flat.length; i += 2) events.push({ type: flat[i], text: flat[i + 1] })
      pageImages = result.images
    } finally {
      shelter.purge()
    }
  }

  const failure = events.find(e => e.type === "error")
  if (failure && !options.error) {
    const label = options.label ? ` [${options.label}]` : ""
    throw new RenderError(
      `${failure.text}\n\nQuitting from lines ${cell.startLine + 1}-${cell.endLine + 1}${label}`,
      "Add `#| error: true` to the cell to show the error in the document instead of stopping the render."
    )
  }

  // A plot belongs after the last expression that drew on its page.
  const lastPlotEvent = new Map()
  events.forEach((e, i) => e.type === "plot" && lastPlotEvent.set(e.text, i))
  events = events.filter((e, i) => e.type !== "plot" || lastPlotEvent.get(e.text) === i)

  if (!options.include) return { markdown: "", events }

  const blocks = []
  let pendingSource = []
  let figureCount = 0
  const codeAttrs = codeBlockAttributes(options)
  const flushSource = () => {
    if (!pendingSource.length) return
    if (options.echo) {
      const echoed = options.echo === "fenced"
        ? `\`\`\`{r}\n${pendingSource.join("\n")}\n\`\`\``
        : pendingSource.join("\n")
      blocks.push(codeBlock(echoed, `${options.echo === "fenced" ? ".markdown" : ".r"} ${codeAttrs}`))
    }
    pendingSource = []
  }

  for (const event of events) {
    if (event.type === "source") {
      pendingSource.push(event.text)
      continue
    }
    flushSource()
    if (!options.output) continue
    if (event.type === "stdout") {
      blocks.push(options.output === "asis" ? event.text : outputBlock("stdout", event.text))
    } else if (event.type === "stderr" || event.type === "error") {
      blocks.push(outputBlock("stderr", event.text))
    } else if (event.type === "plot") {
      const bitmap = pageImages[Number(event.text) - 1]
      if (!bitmap) continue
      images.push(await bitmapToDataUrl(bitmap))
      // A .png name, as pandoc appends default-image-extension to bare names.
      const key = `qp-img-${images.length}.png`
      const displayWidth = Math.round(Number(options["fig-width"] ?? docOptions["fig-width"] ?? 7) * 96)
      figureCount++
      const label = figureCount === 1 && typeof options.label === "string" && options.label.startsWith("fig-") ? options.label : null
      const caption = figureCount === 1 && options["fig-cap"] ? String(options["fig-cap"]) : ""
      const alt = options["fig-alt"] ? ` fig-alt="${String(options["fig-alt"]).replace(/"/g, "&quot;")}"` : ""
      let figure
      if (label && !caption) {
        figure = `::: {#${label}}\n\n![](${key}){width=${displayWidth}${alt}}\n\n:::`
      } else {
        figure = `![${caption}](${key}){${label ? `#${label} ` : ""}width=${displayWidth}${alt}}`
      }
      blocks.push(`::: {.cell-output-display}\n\n${figure}\n\n:::`)
    }
  }
  flushSource()
  if (options.output === "asis") return { markdown: blocks.join("\n\n"), events }
  return { markdown: `::: {${cellDivAttributes(options)}}\n\n${blocks.join("\n\n")}\n\n:::`, events }
}

function nonRCell(cell, options, notices) {
  const lang = cell.lang
  if (lang === "mermaid") {
    return `\`\`\`{=html}\n<pre class="mermaid">${escapeHtml(cell.code)}</pre>\n\`\`\``
  }
  const message = lang === "python"
    ? "Python cells aren't run in this preview yet; only the code is shown."
    : `\`{${lang}}\` cells aren't run in this preview; only the code is shown.`
  if (!notices.includes(message)) notices.push(message)
  if (!options.echo || !options.include) return ""
  return `::: {.cell}\n\n${codeBlock(cell.code, `.${lang} .cell-code`)}\n\n:::`
}

async function renderInlineR(r, text) {
  const pattern = /`\{r\}\s+([^`\n]+?)`/g
  if (!text.match(pattern)) return text
  let out = ""
  let last = 0
  for (const m of text.matchAll(pattern)) {
    out += text.slice(last, m.index)
    try {
      const result = await r.webR.evalR(`.qp$inline(${JSON.stringify(m[1])}, .qp_env)`)
      out += (await result.toArray()).join("")
    } catch (err) {
      throw new RenderError(`Error in inline R code \`${m[1]}\`: ${String(err.message || err).replace(/^Error: /, "")}`)
    }
    last = m.index + m[0].length
  }
  return out + text.slice(last)
}

// The full render ---------------------------------------------------------------------------

async function renderDocument(source, setStatus) {
  const notices = []
  const { yaml, bodyStart } = parseFrontMatter(source)
  const firstBodyLine = source.slice(0, bodyStart).split("\n").length - 1
  const options = resolveFormat(yaml, notices)
  lintKeys(yaml, notices)

  const execute = { ...DEFAULT_CELL_OPTIONS, ...(typeof yaml.execute === "object" ? yaml.execute : {}) }
  const parts = splitCells(source.slice(bodyStart), firstBodyLine)
  const cells = []
  for (const part of parts) {
    if (part.type !== "cell") continue
    const parsed = parseCellOptions(part)
    part.code = parsed.code
    part.options = { ...execute, ...parsed.options }
    cells.push(part)
  }

  const needsR = cells.some(c => c.lang === "r") || parts.some(p => p.type === "markdown" && /`\{r\}\s/.test(p.text))
  setStatus("Loading the Quarto renderer…")
  const quartoReady = loadQuarto()
  let markdownParts = []
  const images = []
  const cellResults = []

  if (needsR) {
    setStatus("Starting R…")
    const r = await loadWebR()
    await withR(async () => {
      await ensurePackages(r, packagesUsed(cells.filter(c => c.lang === "r").map(c => c.code).join("\n")), setStatus)
      await r.webR.evalRVoid(".qp_env <- new.env(parent = globalenv())")
      let rIndex = 0
      for (const part of parts) {
        if (part.type === "verbatim") {
          markdownParts.push(part.text)
        } else if (part.type === "markdown") {
          markdownParts.push(await renderInlineR(r, part.text))
        } else if (part.lang === "r") {
          rIndex++
          setStatus(`Running R cell ${rIndex}…`)
          const { markdown, events } = await runRCell(r, part, part.options, options, images, rIndex)
          cellResults.push({ lang: "r", code: part.code, options: part.options, outputs: events.filter(e => e.type !== "source") })
          markdownParts.push(`\n${markdown}\n`)
        } else {
          markdownParts.push(`\n${nonRCell(part, part.options, notices)}\n`)
          cellResults.push({ lang: part.lang, code: part.code, options: part.options, outputs: [] })
        }
      }
    })
  } else {
    for (const part of parts) {
      if (part.type !== "cell") {
        markdownParts.push(part.text)
      } else {
        markdownParts.push(`\n${nonRCell(part, part.options, notices)}\n`)
        cellResults.push({ lang: part.lang, code: part.code, options: part.options, outputs: [] })
      }
    }
  }

  setStatus("Rendering…")
  const quarto = await quartoReady
  const result = await quarto.render({
    markdown: markdownParts.join("\n") + "\n",
    ...quartoInputs(options, needsR, quarto.bundle)
  })
  const messages = quartoMessages(result)
  if (!result.html || messages.error) {
    throw new RenderError("Quarto could not render this document.", messages.error)
  }
  notices.push(...messages.warnings)

  // Plots were rendered with placeholder file names; swap in the image data.
  const page = new DOMParser().parseFromString(result.html, "text/html")
  for (const img of page.querySelectorAll('img[src^="qp-img-"]')) {
    const index = Number(img.getAttribute("src").match(/^qp-img-(\d+)/)[1]) - 1
    if (images[index]) img.setAttribute("src", images[index])
  }
  postprocess(page, { copyTooltip: quarto.bundle.params.language?.["copy-button-tooltip"] })
  return { page, yaml, body: source.slice(bodyStart), cells: cellResults, notices }
}

// What Quarto's command-line tool derives from the front matter before it
// calls pandoc: document metadata, a few pandoc options, and filter params.
const NOT_METADATA = new Set(["format", "execute", "engine", "jupyter", "knitr", "filters"])

function quartoInputs(options, usesKnitr, bundle) {
  // Like Quarto's metadataAsFormat: options in the execute, render, pandoc,
  // identifier and language groups configure the render; the rest is metadata.
  const formatOptions = new Set(Object.values(bundle.optionGroups).flat())
  const metadata = {}
  for (const [key, value] of Object.entries(options)) {
    if (!NOT_METADATA.has(key) && !formatOptions.has(key)) metadata[key] = value
  }
  if (options.date != null) metadata.date = formatDate(options.date)
  if (options.author != null) {
    // `authors` keeps the full entries; `author` is reduced to names.
    metadata.authors = [].concat(options.author)
    metadata.author = metadata.authors.map(a => (a && typeof a === "object" ? a.name : a))
  }
  if (options.abstract != null && options["abstract-title"] == null) {
    metadata["abstract-title"] = bundle.params.language?.["section-title-abstract"] ?? "Abstract"
  }

  const defaults = {}
  if (options.toc) defaults.toc = true
  if (options["toc-depth"] != null) defaults["toc-depth"] = Number(options["toc-depth"])
  if (usesKnitr) {
    defaults.filters = [...bundle.defaults.filters, "/quarto/share/filters/rmarkdown/pagebreak.lua"]
  }

  // Format options Quarto's CLI copies into filter parameters
  // (quartoFilterParams and crossrefFilterParams in Quarto 1.10).
  const params = { "execution-engine": usesKnitr ? "knitr" : "markdown" }
  for (const key of PARAM_OPTIONS) {
    if (options[key] != null) params[key] = options[key]
  }
  if (options["number-offset"] != null) {
    params["number-offset"] = [].concat(options["number-offset"])
    if (options["number-sections"] == null) params["number-sections"] = true
  }
  return { metadata, defaults, params }
}

const PARAM_OPTIONS = [
  "code-fold", "code-summary", "code-line-numbers", "fig-align", "fig-pos", "fig-env",
  "tbl-colwidths", "html-table-processing", "output-location", "listings",
  "number-sections", "number-depth"
]

// pandoc's stderr: Quarto's filters print `WARNING (file:line) message` and
// `ERROR ...` lines, pandoc itself prints `[WARNING] message`, and a failed
// render ends with pandoc's error message.
function quartoMessages(result) {
  const plain = line => line.replace(/\x1b\[[0-9;]*m/g, "")
  const clean = line => plain(line).replace(/^(\[WARNING\]|(WARNING|ERROR|INFO) \([^)]*\))\s*/, "").trim()
  const isWarning = line => /^(\[WARNING\]|WARNING)/.test(plain(line))
  const warnings = result.stderr.filter(isWarning).map(clean)
  const errors = result.stderr.filter(line => /^ERROR/.test(plain(line))).map(clean)
  if (result.exitCode !== 0 && errors.length === 0) {
    errors.push(...result.stderr.filter(line => !isWarning(line)).map(plain))
  }
  return { warnings: [...new Set(warnings)], error: errors.join("\n").trim() }
}

// Preview frame ---------------------------------------------------------------------------------

const FRAME_SCRIPT = `
document.addEventListener("click", event => {
  const link = event.target.closest("a[href]")
  if (!link || link.hasAttribute("data-bs-toggle")) return
  const href = link.getAttribute("href")
  if (href.startsWith("#")) {
    event.preventDefault()
    const target = document.getElementById(decodeURIComponent(href.slice(1)))
    if (target) target.scrollIntoView({ behavior: "smooth" })
  } else if (href) {
    link.target = "_blank"
  }
})
if (document.querySelector(".mermaid") && window.mermaid) mermaid.run()
`

// The preview is sandboxed without same-origin access, so Web Storage
// throws. Quarto's page scripts keep preferences there; give them an
// in-memory store instead.
const STORAGE_SHIM = `
for (const name of ["localStorage", "sessionStorage"]) {
  try { window[name].length } catch {
    const data = new Map()
    Object.defineProperty(window, name, { configurable: true, value: {
      get length() { return data.size },
      key: i => [...data.keys()][i] ?? null,
      getItem: k => data.has(String(k)) ? data.get(String(k)) : null,
      setItem: (k, v) => void data.set(String(k), String(v)),
      removeItem: k => void data.delete(String(k)),
      clear: () => data.clear()
    } })
  }
}
`

// The page pandoc produced from Quarto's template, plus the HTML
// dependencies Quarto adds to the end of <head> when it writes the file.
function frameDocument(page, headTags) {
  const doc = page.cloneNode(true)
  const shim = doc.createElement("script")
  shim.textContent = STORAGE_SHIM
  doc.head.prepend(shim)
  const libs = asset("quarto-libs/")
  doc.head.insertAdjacentHTML("beforeend", [
    ...headTags.map(tag => tag.replaceAll("{{LIBS}}", libs)),
    `<link rel="stylesheet" href="${asset("preview-frame.css")}">`,
    ...(doc.querySelector(".mermaid") ? [`<script src="${settings.mermaidUrl}"></script>`] : [])
  ].join("\n"))
  const script = doc.createElement("script")
  script.textContent = FRAME_SCRIPT
  doc.body.appendChild(script)
  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML
}

// Playground UI -----------------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

// Feedback messages may use `code` spans.
function inlineMarkdown(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>")
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value)
  }
  node.append(...children)
  return node
}

const AsyncFunction = (async () => {}).constructor

class Playground {
  constructor(root, config, checks, hints, solutions) {
    this.root = root
    this.config = config
    this.options = config.options || {}
    this.checks = checks
    this.hints = hints
    this.solutions = solutions
    this.storageKey = `quarto-simulator:${location.pathname}:${config.id}`
    this.source = localStorage.getItem(this.storageKey) ?? config.source
    this.rendered = null
    this.renderedSource = null
    this.rendering = null
    this.hintsShown = 0
    this.build()
  }

  build() {
    const opts = this.options
    this.status = el("span", { class: "qp-status", role: "status" })
    this.renderButton = el("button", { type: "button", class: "qp-btn qp-btn-primary", title: "Render (Ctrl/Cmd + Shift + K)", onclick: () => this.render() }, "▶ Render")
    const toolbar = el("div", { class: "qp-toolbar" },
      this.renderButton,
      el("button", { type: "button", class: "qp-btn", onclick: () => this.reset() }, "↺ Reset"),
      this.status
    )
    const exerciseButtons = el("div", { class: "qp-toolbar-right" })
    if (this.hints.length) {
      this.hintButton = el("button", { type: "button", class: "qp-btn", onclick: () => this.showHint() }, "💡 Hint")
      exerciseButtons.append(this.hintButton)
    }
    if (this.solutions.length) {
      exerciseButtons.append(el("button", { type: "button", class: "qp-btn", onclick: () => this.showSolution() }, "Show solution"))
    }
    if (this.checks.length) {
      exerciseButtons.append(el("button", { type: "button", class: "qp-btn qp-btn-check", onclick: () => this.check() }, "✓ Check"))
    }
    toolbar.append(exerciseButtons)

    const editorPane = el("div", { class: "qp-pane qp-editor-pane" },
      el("div", { class: "qp-pane-header" }, opts.filename || "document.qmd"))
    const editorHost = el("div", { class: "qp-editor" })
    editorPane.append(editorHost)

    this.frame = el("iframe", {
      class: "qp-frame",
      title: "Rendered preview",
      sandbox: "allow-scripts allow-popups allow-popups-to-escape-sandbox"
    })
    this.placeholder = el("div", { class: "qp-placeholder" }, "Press ▶ Render to see your document.")
    const previewPane = el("div", { class: "qp-pane qp-preview-pane" },
      el("div", { class: "qp-pane-header", title: "A simulation of quarto render for learning; not every Quarto feature is supported." }, "Preview (simulated Quarto)"), this.placeholder, this.frame)

    const height = Number(opts.height) || 460
    const panes = el("div", { class: `qp-panes qp-layout-${opts.layout === "vertical" ? "vertical" : "horizontal"}`, style: `--qp-height: ${height}px` },
      editorPane, previewPane)

    this.log = el("div", { class: "qp-log", hidden: "" })
    this.feedback = el("div", { class: "qp-feedback", hidden: "" })
    this.extras = el("div", { class: "qp-extras" })
    this.root.append(toolbar, panes, this.log, this.feedback, this.extras)

    this.editor = createEditor({
      parent: editorHost,
      doc: this.source,
      onChange: text => this.changed(text),
      onRender: () => this.render()
    })
  }

  changed(text) {
    this.source = text
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      if (text === this.config.source) localStorage.removeItem(this.storageKey)
      else localStorage.setItem(this.storageKey, text)
    }, 400)
    if (this.options.live) {
      clearTimeout(this.liveTimer)
      this.liveTimer = setTimeout(() => this.render(), 800)
    }
  }

  setStatus(text, kind = "") {
    this.status.textContent = text
    this.status.className = `qp-status ${kind}`
  }

  reset() {
    setEditorText(this.editor, this.config.source)
    localStorage.removeItem(this.storageKey)
    this.feedback.hidden = true
    this.render()
  }

  // Renders the current text. A render requested while one is running is
  // queued, so the preview always ends on the latest text.
  async render() {
    if (this.rendering) {
      this.pending = true
      return this.rendering
    }
    const source = this.source
    this.renderButton.disabled = true
    const started = performance.now()
    this.rendering = (async () => {
      try {
        const result = await renderDocument(source, text => this.setStatus(text, "qp-busy"))
        this.rendered = { ...result, source, error: null }
        this.frame.srcdoc = frameDocument(result.page, (await loadQuarto()).bundle.headTags)
        this.frame.classList.remove("qp-stale")
        this.placeholder.hidden = true
        this.showLog(result.notices, null)
        const elapsed = performance.now() - started
        this.setStatus(`Rendered in ${elapsed < 1000 ? `${Math.round(elapsed)} ms` : `${(elapsed / 1000).toFixed(1)} s`}`, "qp-ok")
      } catch (err) {
        const error = err instanceof RenderError ? err : new RenderError(String(err.message || err))
        if (!(err instanceof RenderError)) console.error(err)
        this.rendered = { source, error, page: null, notices: [] }
        this.frame.classList.add("qp-stale")
        this.showLog([], error)
        this.setStatus("Render failed", "qp-error")
      }
    })()
    await this.rendering
    this.rendering = null
    this.renderButton.disabled = false
    if (this.pending) {
      this.pending = false
      if (this.source !== source) return this.render()
    }
  }

  showLog(notices, error) {
    this.log.replaceChildren()
    if (error) {
      this.log.append(el("div", { class: "qp-log-error" },
        el("strong", {}, "ERROR: "), el("pre", {}, error.message),
        ...(error.detail ? [el("pre", { class: "qp-log-detail" }, error.detail)] : [])))
    }
    for (const notice of notices) {
      const item = el("div", { class: "qp-log-warning" })
      item.innerHTML = `<strong>WARNING:</strong> ${inlineMarkdown(notice)}`
      this.log.append(item)
    }
    this.log.hidden = !error && notices.length === 0
  }

  showHint() {
    const hint = this.hints[this.hintsShown]
    if (!hint) return
    hint.hidden = false
    this.extras.append(hint)
    this.hintsShown++
    if (this.hintsShown >= this.hints.length) this.hintButton.disabled = true
  }

  showSolution() {
    for (const solution of this.solutions) {
      solution.hidden = false
      const code = solution.querySelector("pre code")
      if (code && !solution.querySelector(".qp-use-solution")) {
        solution.append(el("button", {
          type: "button",
          class: "qp-btn qp-use-solution",
          onclick: () => { setEditorText(this.editor, code.textContent.replace(/\n$/, "")); this.render() }
        }, "Copy solution into the editor"))
      }
      this.extras.append(solution)
    }
  }

  async check() {
    if (!this.rendered || this.rendered.source !== this.source || this.rendering) await this.render()
    const rendered = this.rendered
    const showFeedback = (correct, message) => {
      this.feedback.hidden = false
      this.feedback.className = `qp-feedback ${correct ? "qp-correct" : "qp-incorrect"}`
      this.feedback.innerHTML = `<strong>${correct ? "Correct!" : "Not quite."}</strong> ${inlineMarkdown(message)}`
    }
    if (rendered.error) {
      showFeedback(false, "Your document didn't render. Fix the error shown above, then check again.")
      return
    }
    const html = rendered.page
    const context = {
      source: rendered.source,
      yaml: rendered.yaml,
      body: rendered.body,
      html,
      text: html.body.textContent,
      cells: rendered.cells,
      warnings: rendered.notices
    }
    const pass = (message = "Nice work!") => ({ correct: true, message })
    const fail = (message = "Try again.") => ({ correct: false, message })
    let outcome
    for (const code of this.checks) {
      try {
        outcome = await new AsyncFunction("result", "pass", "fail", code)(context, pass, fail)
      } catch (err) {
        console.error(err)
        outcome = fail(`The checking code raised an error: ${err.message}`)
      }
      outcome ??= pass()
      if (!outcome.correct) break
    }
    showFeedback(outcome.correct, outcome.message)
  }
}

// Startup ---------------------------------------------------------------------------------------------

function init() {
  const byExercise = cls => {
    const map = new Map()
    for (const node of document.querySelectorAll(cls)) {
      const id = node.dataset.exercise
      if (!map.has(id)) map.set(id, [])
      map.get(id).push(node)
    }
    return map
  }
  const checks = byExercise(".quarto-simulator-check")
  const hints = byExercise(".quarto-simulator-hint")
  const solutions = byExercise(".quarto-simulator-solution")

  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      observer.unobserve(entry.target)
      entry.target.qmdPlayground.render()
    }
  }, { rootMargin: "200px" })

  for (const root of document.querySelectorAll(".quarto-simulator")) {
    const config = readJson(root.querySelector(".quarto-simulator-config"))
    const exercise = config.options?.exercise
    const playground = new Playground(
      root,
      config,
      (checks.get(exercise) || []).map(node => readJson(node).code),
      hints.get(exercise) || [],
      solutions.get(exercise) || []
    )
    root.qmdPlayground = playground
    if (playground.options.autorender !== false) observer.observe(root)
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init)
else init()
