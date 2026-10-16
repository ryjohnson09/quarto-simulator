// End-to-end tests: drive the rendered website (_site/) in a real browser.
//
//   quarto render            # build _site/
//   npm test                 # or: node tests/run.mjs
//
// Every playground on every page must render (or fail, where failing is the
// point), every exercise in the example lesson must reject its starting
// document and accept its solution, plots must load, and long-running Python
// must be stoppable. pandoc, webR and Pyodide download from their CDNs, so
// the tests need a network connection.
//
// Set BROWSER_CHANNEL=chrome to use an installed Chrome instead of
// Playwright's Chromium.

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { extname, join, normalize } from "node:path"
import { chromium } from "playwright"

const SITE = new URL("../_site/", import.meta.url).pathname
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff": "font/woff",
  ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain"
}

// Playgrounds whose starting document is meant to fail.
const EXPECTED_FAILURES = {
  "vignettes/r-code": ["quarto-simulator-playground-2"],
  "vignettes/example-lesson": ["quarto-simulator-ex-yaml"]
}
const PAGES = [
  "index", "vignettes/get-started", "vignettes/exercises", "vignettes/r-code",
  "vignettes/python-code", "vignettes/example-lesson", "vignettes/how-it-works"
]

// --- A static server for _site/ ------------------------------------------------

// Like hosts that gate files behind cookies or signed URLs (an LMS such as
// SkillJar), refuse cross-site requests. The preview iframe has an opaque
// origin, so anything it fetched for itself would be refused here.
const server = createServer(async (req, res) => {
  if (req.headers["sec-fetch-site"] === "cross-site") return res.writeHead(403).end("forbidden")
  const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^(\.\.[/\\])+/, "")
  const file = join(SITE, path.endsWith("/") ? path + "index.html" : path)
  try {
    const body = await readFile(file)
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" })
    res.end(body)
  } catch {
    res.writeHead(404).end("not found")
  }
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
const BASE = `http://127.0.0.1:${server.address().port}`

// --- Helpers -------------------------------------------------------------------

let failed = 0
const results = []
function report(ok, name, detail = "") {
  if (!ok) failed++
  results.push(ok)
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${detail ? ` — ${detail}` : ""}`)
}

const browser = await chromium.launch(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {})
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
const pageErrors = []
page.on("pageerror", error => pageErrors.push(error.message))

const status = sel => page.locator(`${sel} .qp-status`).innerText()
const log = async sel => (await page.locator(`${sel} .qp-log`).innerText()).trim()
const idle = sel => page.waitForFunction(s => {
  const root = document.querySelector(s)
  return /Rendered|failed/.test(root.querySelector(".qp-status").textContent) && !root.qmdPlayground.rendering
}, sel, { timeout: 300_000 })
const source = sel => page.evaluate(s => document.querySelector(s).qmdPlayground.source, sel)
const setSource = (sel, text) => page.evaluate(([s, t]) => {
  const view = document.querySelector(s).qmdPlayground.editor
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t } })
}, [sel, text])

async function open(path) {
  await page.goto(`${BASE}/${path}.html`)
  await page.evaluate(() => localStorage.clear())
  await page.reload()
}

// Renders (retrying once if a CDN download failed) and returns the status.
async function render(sel, { click = true } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (click || attempt > 0) {
      await page.locator(`${sel} .qp-btn-primary`).click()
      await page.waitForTimeout(300)
    }
    await idle(sel)
    const text = await status(sel)
    if (/Rendered/.test(text) || !/download|fetch/i.test(await log(sel))) return text
  }
  return status(sel)
}

async function check(sel) {
  await page.locator(`${sel} .qp-btn-check`).click()
  await page.waitForFunction(s => !document.querySelector(`${s} .qp-feedback`).hidden, sel, { timeout: 300_000 })
  await idle(sel)
  await page.waitForTimeout(200)
  const text = await page.locator(`${sel} .qp-feedback`).innerText()
  await page.evaluate(s => (document.querySelector(`${s} .qp-feedback`).hidden = true), sel)
  return text
}

// The preview is an iframe whose srcdoc is replaced on each render; wait for
// the new document before reading it.
async function preview(sel) {
  const frame = page.frameLocator(`${sel} iframe`)
  await frame.locator("main").waitFor({ timeout: 30_000 })
  await page.waitForTimeout(500)
  return frame
}

async function imagesLoaded(sel) {
  await page.waitForTimeout(1000)
  return (await preview(sel)).locator("main img")
    .evaluateAll(images => images.length > 0 && images.every(img => img.complete && img.naturalWidth > 0))
}

// --- 1. Every playground renders ---------------------------------------------------

console.log("\nEvery playground on every page")
for (const path of PAGES) {
  await open(path)
  const ids = await page.locator(".quarto-simulator").evaluateAll(els => els.map(el => el.id))
  for (const id of ids) {
    const sel = `#${id}`
    await page.locator(sel).scrollIntoViewIfNeeded()
    if ((await source(sel)).includes("while True")) continue // tested below
    const autorender = await page.evaluate(s => document.querySelector(s).qmdPlayground.options.autorender !== false, sel)
    const text = await render(sel, { click: !autorender })
    const shouldFail = EXPECTED_FAILURES[path]?.includes(id)
    report(shouldFail ? /failed/.test(text) : /Rendered/.test(text), `${path} ${id}`,
      shouldFail ? "fails as intended" : text + (/failed/.test(text) ? ` | ${(await log(sel)).split("\n").slice(0, 3).join(" ")}` : ""))
  }
}

// --- 1b. The preview is styled, with nothing fetched by the frame itself ------------

console.log("\nPreview styling")
{
  await open("index")
  const sel = `#${await page.locator(".quarto-simulator").first().getAttribute("id")}`
  await page.locator(sel).scrollIntoViewIfNeeded()
  await render(sel)
  const frame = await preview(sel)
  const font = await frame.locator("body").evaluate(body => getComputedStyle(body).fontFamily)
  report(!/times/i.test(font), "Quarto's Bootstrap CSS styles the preview", font)
  report(await frame.locator("link[rel=stylesheet], script[src]").count() === 0, "the preview frame requests no CSS or JavaScript itself")
}

// --- 2. Exercises: starting documents fail, solutions pass ---------------------------

console.log("\nExercises in the example lesson")
await open("vignettes/example-lesson")
for (const id of ["ex-toc", "ex-cells", "ex-python"]) {
  const sel = `#quarto-simulator-${id}`
  await page.locator(sel).scrollIntoViewIfNeeded()
  await idle(sel)
  const before = await check(sel)
  report(/^Not quite/.test(before), `${id}: starting document is rejected`, before)
  await page.locator(`${sel} button:has-text("Show solution")`).click()
  // Playgrounds above can still change height as they render, so a click can
  // land where the button was; retry until the editor holds the solution.
  const starting = await source(sel)
  for (let attempt = 0; attempt < 3 && (await source(sel)) === starting; attempt++) {
    await page.locator(`${sel} button:has-text("Copy solution")`).click()
    await page.waitForTimeout(500)
  }
  await idle(sel)
  const after = await check(sel)
  report(/^Correct/.test(after), `${id}: solution is accepted`, after)
  if (id === "ex-toc") {
    // This exercise's vertical layout is wide enough for Quarto's margin TOC.
    const toc = (await preview(sel)).locator("#quarto-margin-sidebar nav#TOC")
    report(await toc.isVisible(), "ex-toc: the TOC shows in Quarto's right margin")
  }
}
{
  const sel = "#quarto-simulator-ex-yaml"
  await page.locator(sel).scrollIntoViewIfNeeded()
  await idle(sel)
  const error = await log(sel)
  report(/line 7/.test(error) && /quote on line 2 is never closed/.test(error), "ex-yaml: the YAML error points to the unclosed quote")
  const fixed = (await source(sel)).replace('"Quarterly report', '"Quarterly report"').replace("  toc: true", "    toc: true")
  await setSource(sel, fixed)
  const after = await check(sel)
  report(/^Correct/.test(after), "ex-yaml: the fixed document is accepted", after)
}
{
  const sel = "#quarto-simulator-ex-cells"
  report(await imagesLoaded(sel), "ex-cells: the R plot loads")
}

// --- 3. Python ---------------------------------------------------------------------

console.log("\nPython")
await open("vignettes/python-code")
{
  const sel = "#quarto-simulator-playground-1"
  await page.locator(sel).scrollIntoViewIfNeeded()
  await render(sel, { click: false })
  const frame = await preview(sel)
  report(await frame.locator("table.dataframe").count() > 0, "pandas tables render as tables")
  report(/best score was 95/.test(await frame.locator("main").innerText()), "inline `{python}` values are filled in")
  report(await frame.locator(".cell-output-error").count() === 1, "`error: true` shows the traceback in the document")

  await setSource(sel, '---\ntitle: "x"\n---\n\n```{python}\nundefined_name + 1\n```\n')
  await render(sel)
  report(/NameError/.test(await log(sel)) && /Quitting from Python cell 1/.test(await log(sel)), "an uncaught error stops the render and names the cell")
}
{
  const sel = "#quarto-simulator-playground-2"
  await page.locator(sel).scrollIntoViewIfNeeded()
  await render(sel)
  report(await imagesLoaded(sel), "matplotlib figures load")
}
{
  const sel = "#quarto-simulator-playground-3"
  await page.locator(sel).scrollIntoViewIfNeeded()
  await page.locator(`${sel} .qp-btn-primary`).click()
  const stop = page.locator(`${sel} button:has-text("Stop")`)
  await stop.waitFor({ state: "visible", timeout: 300_000 })
  report(await page.evaluate(() => 1 + 1) === 2, "the page stays responsive during an infinite loop")
  await stop.click()
  await idle(sel)
  report(/stopped/.test(await log(sel)), "Stop ends the running cell")
  await setSource(sel, '---\ntitle: "x"\n---\n\n```{python}\nprint("fresh")\n```\n')
  await render(sel)
  report(/fresh/.test(await (await preview(sel)).locator("main").innerText()), "Python works again after stopping")
}

// --- Summary -------------------------------------------------------------------------

report(pageErrors.length === 0, "no uncaught page errors", pageErrors.join("; "))
await browser.close()
server.close()
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
