# quarto-simulator

A Quarto extension for **teaching the basics of Quarto and markdown inside a
Quarto document**. It gives learners an editor and a live preview that
*simulate* `quarto render` in the browser. It is not Quarto, but it is close
enough to practise with.

`quarto-simulator` turns a block in a lesson into an editor and a preview,
with optional graded exercises. Everything runs in the learner's browser, so
lessons stay static HTML and need no server.

**What "simulated" means:** the markdown-to-HTML step runs Quarto's own Lua
filters inside a WebAssembly build of pandoc, so callouts, cross-references,
figures and so on look as they do in real Quarto. Everything around that step
is reimplemented for the browser:
- reading the YAML and setting up the render (Quarto's command-line tool);
- running R code (webR plus an imitation of knitr);
- running Python code (IPython in Pyodide, with Quarto's Jupyter output
  format ported to JavaScript);
- part of Quarto's HTML post-processing.

Only HTML output is supported. See [How it works](#how-it-works) for the
details and the known differences.

## Install

Install the extension into a Quarto project with:

```bash
quarto add ryjohnson09/quarto-simulator
```

This copies only `_extensions/quarto-simulator/` into the project. The build
tooling in `tools/` stays here. You can also install from a local clone with
`quarto add /path/to/quarto-simulator`.
Lessons can be rendered with Quarto 1.9 or later. The in-browser renderer is
Quarto 1.10.19 whichever version renders the lesson.

## Try it

```bash
quarto preview index.qmd
```

`index.qmd` is a sample lesson with one free-play playground and four
exercises: document options and callouts, code cell options and figure
cross-references, fixing broken YAML, and Python cells with a table
cross-reference and inline code. It must be served over HTTP, as
`quarto preview` does. Opening the HTML file directly won't work.

## Authoring

Add the filter, and set `engine: markdown` so that neither knitr nor Jupyter
runs the code cells inside the playgrounds when the lesson itself renders:

```yaml
---
title: "My lesson"
engine: markdown
filters:
  - quarto-simulator
---
```

### A playground

Use a fence with more backticks than any fence inside the starter document:

`````markdown
````{quarto-simulator}
---
title: "Hello"
---

```{r}
plot(cars)
```
````
`````

Options go in `#|` lines at the top of the block:

| Option       | Default        | Meaning                                                                     |
|--------------|----------------|-----------------------------------------------------------------------------|
| `exercise`   | none           | ID that links the playground to checks, hints and solutions                 |
| `file`       | none           | Load the starter document from a file, e.g. `_starters/ex1.qmd`             |
| `height`     | `460`          | Height of the editor and preview, in pixels                                 |
| `layout`     | `horizontal`   | `vertical` stacks the preview under the editor                              |
| `column`     | body           | Quarto column class, e.g. `page-inset-right`                                |
| `autorender` | `true`         | Render when the playground first scrolls into view                          |
| `live`       | `false`        | Re-render as the learner types                                              |
| `filename`   | `document.qmd` | Name shown above the editor                                                 |

If the lesson itself must run R or Python code, it can't use `engine: markdown`. In
that case, put each starter document in a file and use `#| file:`, so the
lesson source has no nested cells. Prefix the file name with `_` so that
Quarto projects don't render it as a page.

You can set a default `column` for every playground, and self-host the
binaries, in the lesson's YAML:

```yaml
quarto-simulator:
  column: page-inset-right
  pandoc-wasm-url: /assets/pandoc.wasm
  webr-url: https://webr.r-wasm.org/v0.6.0/webr.mjs
  pyodide-url: https://cdn.jsdelivr.net/pyodide/v314.0.7/full/pyodide.mjs
```

### Checks, hints and solutions

Hints and solutions use the same `exercise="..."` convention as Quarto Live:

`````markdown
::: {.hint exercise="ex1"}
Table of contents is a YAML option.
:::

::: {.solution exercise="ex1"}
```markdown
---
title: "Hello"
toc: true
---
```
:::

```{quarto-simulator-check}
#| exercise: ex1
if (result.yaml.toc !== true) return fail("Add a table of contents.")
return pass("Nice!")
```
`````

The **Hint** button reveals one hint at a time. If a solution contains a code
block, it gets a **Copy solution into the editor** button.

A check is the body of an async JavaScript function. It returns `pass(message)`
or `fail(message)`, and backticks in messages are shown as code. It receives
`result`, which has these fields:

| Field      | Contents                                                                      |
|------------|-------------------------------------------------------------------------------|
| `source`   | The learner's text                                                            |
| `yaml`     | The parsed front matter                                                       |
| `body`     | Everything after the front matter                                             |
| `html`     | The rendered preview as a `Document`, so `querySelector` works                |
| `text`     | The rendered preview as plain text                                            |
| `cells`    | `[{ lang, code, options, outputs: [{ type, text }] }]`. Output types: `stdout`, `stderr`, `error`, `plot`, and for Python also `result` (the value of the last line) and `display` |
| `warnings` | Render warnings, such as unresolved cross-references                          |

If the document fails to render, the check fails automatically and points the
learner to the error.

## How it works

The playground runs **Quarto's own Lua filters, reader, template and data
directory** inside the official [pandoc WebAssembly build](https://github.com/pandoc/pandoc-wasm).
`pandoc.wasm` runs as a command-line program, with the arguments,
environment variables and files that `quarto render` gives pandoc. The parts of Quarto that
are TypeScript or R (the command-line tool and knitr) can't run in the
browser, so those steps are reimplemented in JavaScript:

| Step                      | `quarto render`                     | Playground                                                                         |
|---------------------------|-------------------------------------|------------------------------------------------------------------------------------|
| Parse YAML, build options | Quarto CLI (TypeScript)             | **Reimplemented**: [js-yaml](https://github.com/nodeca/js-yaml) plus a mapping of the options a playground document uses |
| Run R code                | knitr with Quarto's hooks           | **Reimplemented**: [webR](https://docs.r-wasm.org/webr/) plus an imitation of knitr's output that emits the same markdown and cell attributes as Quarto's knitr hooks |
| Run Python code           | Jupyter: an IPython kernel, then Quarto turns the outputs into markdown | **Mostly real**: IPython in [Pyodide](https://pyodide.org) in a Web Worker, running Quarto's own kernel setup code (`setup.py`). The step from outputs to markdown is ported from Quarto (`tools/vendor/jupyter-markdown.js`) |
| Markdown → HTML           | pandoc 3.10 + Quarto's Lua          | **Real**: pandoc 3.10 (wasm) + Quarto 1.10.19's `qmd-reader.lua`, `main.lua`, `init.lua`, template and partials |
| HTML post-processing      | Quarto CLI (TypeScript)             | **Partly ported** from Quarto's source (`tools/vendor/quarto-postprocess.js`)      |
| Page assets               | Quarto's Bootstrap, quarto.js, etc. | **Real**: the files from a Quarto 1.10.19 render                                   |

**Verified:** for a document covering callouts, tabsets, subfigures,
equations, theorems, margin content, footnotes, shortcodes, code annotations
and an R figure, pandoc-wasm's output is identical to native Quarto 1.10.19's
pandoc output (after normalizing random caption IDs). Warnings match too.
For example, `Unable to resolve crossref @fig-nope` comes from the same line
of `main.lua`.

**Python** was checked the same way, with documents covering printed output,
expression values, warnings, errors, `eval`/`echo`/`output`/`include`,
`echo: fenced`, matplotlib figures (labelled, captioned and with subcaptions),
pandas tables, `display(Markdown(...))` and inline `{python}` expressions. The
final HTML is identical to native Quarto 1.10.19 with an IPython kernel, apart
from figure widths that can differ by a pixel (font metrics) and the file
name shown in Python warnings.

**Remaining differences** in the final page come from Quarto's TypeScript
post-processing that isn't ported yet: margin-column layout
(`processColumnElements`), code annotation markup (`processCodeAnnotations`)
and the footnotes appendix (`processDocumentAppendix`). The table of contents
also stays in the document body (like `toc-location: body`), because the
preview pane has no margin.

### The Quarto runtime bundle

`tools/vendor/build-quarto-runtime.mjs` renders a small document with a real
Quarto installation, using a logging stand-in for pandoc (`QUARTO_PANDOC`). It
captures exactly what Quarto passed to pandoc: defaults, filter parameters,
the patched template and the include files. It then packs these with Quarto's
Lua files into `resources/quarto-runtime.json` (about 2 MB, or 420 KB
gzipped) and copies the page assets to `resources/quarto-libs/`.

Each render starts a fresh `pandoc.wasm` instance through the
[WASI shim](https://github.com/bjorn3/browser_wasi_shim), much as Quarto starts
a pandoc process: `pandoc --defaults defaults.yaml`, with Quarto's
environment variables (`QUARTO_FILTER_PARAMS` and others, plus `LUA_PATH` for
the data directory) and an in-memory file system. The compiled module is
reused, so starting an instance takes about 25 ms. Running in the browser
needs two adaptations:

* Quarto's R syntax definition (`r.xml`) is renamed from "R Script" to "r".
  pandoc looks up a code block's language by name first, and otherwise by
  file extension, which decodes every built-in syntax definition, costing
  about a second in wasm on every render. The highlighting rules are
  unchanged.
* The preview iframe is sandboxed, so `quarto.js` is bundled into a classic
  script (sandboxed frames can't load module scripts without CORS), and Web
  Storage is replaced with an in-memory store.

**The Quarto version must match the pandoc version.** Quarto's filters are
written against a specific pandoc. pandoc-wasm 1.1.0 is pandoc 3.10, which
matches Quarto 1.10. Quarto 1.9, which uses pandoc 3.6, fails on tables.
Older pandoc wasm builds (`wasm-pandoc` 0.x) can't help, because they have no
Lua support. To rebuild from a different Quarto installation:

```bash
cd tools/vendor
npm install
QUARTO=/path/to/quarto-1.10.x/bin/quarto npm run build-quarto-runtime
npm run build    # vendor.js: CodeMirror, js-yaml, the renderer and post-processing
```

### Performance

All playgrounds on a page share one pandoc instance, one R session and one
Python session, which load on first use. The first render downloads pandoc
(about 16 MB gzipped), plus webR if the document has R code, or Pyodide and
IPython (about 15 MB) if it has Python code. Python packages download when a
document first imports them: numpy and pandas about 8 MB, matplotlib about
13 MB. Packages Pyodide doesn't include are installed from PyPI if they are
pure Python (seaborn, for example). After that, a render takes about
0.5 seconds, most of it spent loading Quarto's 25,000 lines of Lua. A code
block whose language pandoc only knows by an alias or not at all (`md`,
`py`, `sh`, `js`, `text`, `mermaid`…) adds about a second, for the
syntax-definition lookup described above. Full names (`markdown`, `python`,
`bash`, `javascript`) don't.
Learners' edits are saved in `localStorage`, and **Reset** restores the
starter document.

### Not supported

* Output formats other than HTML. For `format: pdf` and others, a notice
  explains that the preview shows HTML.
* `theme`, Julia execution, OJS, bibliographies, multi-file projects, local
  images, and third-party Quarto extensions.
* Python packages that Pyodide doesn't include and that aren't pure Python,
  interactive widgets (plotly, ipywidgets), and reading local files.
* Documents with both R and Python. Quarto runs these through knitr and
  reticulate. The playground runs both languages, but formats the Python
  output only approximately, and the languages can't share variables
  (`py$x`, `r.x`).
* Interrupting infinite loops in R. This would need cross-origin isolation
  headers on the host. Python runs in a Web Worker, so a **Stop** button
  appears when a Python cell runs for a while; stopping restarts Python.
* Quarto's YAML schema validation, which is TypeScript. Only typo hints are
  implemented.

## Layout

```
_extensions/quarto-simulator/
  _extension.yml
  quarto-simulator.lua              lesson-time filter: authoring syntax → widgets
  resources/
    quarto-simulator.js             runtime: editor, R execution, render, checks
    python-worker.js              Python "kernel": Pyodide + IPython in a Web Worker
    quarto-runtime.json           generated: Quarto's Lua, template, defaults, params
    quarto-libs/                  generated: Quarto's page assets (Bootstrap, quarto.js, …)
    quarto-libs.lua               generated: list of quarto-libs files for the filter
    quarto-simulator.css            playground UI
    preview-frame.css             adjustments inside the preview iframe
    vendor.js                     generated bundle
tools/vendor/
  build-quarto-runtime.mjs        captures a real Quarto render into the runtime bundle
  quarto-pandoc.js                runs pandoc.wasm the way Quarto runs pandoc
  quarto-postprocess.js           port of Quarto's HTML post-processing
  jupyter-markdown.js             port of Quarto's Jupyter cell-to-markdown step
  entry.js                        vendor.js entry point
index.qmd                         sample lesson
```

## License

MIT, see [LICENSE](LICENSE). Exceptions:

* Quarto's files in `quarto-runtime.json` and `quarto-libs/` are from
  [quarto-cli](https://github.com/quarto-dev/quarto-cli) (MIT license) and the
  libraries it ships, such as Bootstrap, under their own licenses.
* `vendor.js` bundles third-party code under its own licenses: CodeMirror,
  js-yaml, ansi_up, the WASI shim (MIT or Apache-2.0).
* Pyodide (MPL-2.0) and webR are not included. They are downloaded at
  runtime.
* `pandoc.wasm` (GPL-2.0-or-later) is not included. It is downloaded at
  runtime and run as a separate program, through its standard WASI command
  interface. No pandoc-wasm JavaScript is used.

## Open questions before production use

* **SkillJar embedding.** Not tested. The playground needs ES modules,
  `fetch` to the wasm and webR hosts, and iframes with `srcdoc`.
* **Hosting the binaries.** `pandoc.wasm` comes from unpkg by default.
  jsDelivr refuses files this large. Academy should self-host it, with gzip
  or brotli compression, and set `pandoc-wasm-url`.
* **Keeping versions in step.** When Quarto moves to a newer pandoc, update
  pandoc-wasm to the same version and rebuild the runtime bundle.
* **Real knitr.** knitr and Quarto's knitr hooks (`share/rmd/hooks.R`) are
  plain R, so they could run in webR to replace the knitr imitation. Plots
  would need a file-based graphics device (for example `svglite`).
