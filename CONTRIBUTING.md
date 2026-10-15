# Contributing

Thanks for looking. Bug reports and pull requests are both welcome.

## Getting set up

```bash
git clone https://github.com/ryjohnson09/quarto-simulator
cd quarto-simulator
npm install                     # test dependencies (Playwright)
npm install --prefix tools/vendor   # build dependencies (esbuild, CodeMirror, …)
npx playwright install chromium
quarto render                   # build the website into _site/
npm test
```

You need Node 20+ and Quarto 1.9+. Neither `npm install` is needed to *use*
the extension: everything it needs is committed in `_extensions/`.

To work on the site, `quarto preview` serves it and re-renders on save.
Changes to files in `_extensions/` don't trigger a re-render; save a page or
restart the preview.

## How the pieces fit together

```
_extensions/quarto-simulator/
  quarto-simulator.lua      the filter: turns blocks into widgets at lesson render time
  resources/
    quarto-simulator.js     runtime: editor, YAML, R execution, render, checks
    python-worker.js        Python "kernel": IPython in Pyodide, in a Web Worker
    quarto-simulator.css    playground UI
    preview-frame.css       adjustments inside the preview iframe
    vendor.js               GENERATED from tools/vendor/ by `npm run build`
    quarto-runtime.json     GENERATED: Quarto's Lua, template, defaults, params
    quarto-libs/            GENERATED: Quarto's page assets (Bootstrap, quarto.js, …)
    quarto-libs.lua         GENERATED: the list of quarto-libs files
tools/vendor/
  entry.js                  vendor.js entry point: editor setup and exports
  quarto-pandoc.js          runs pandoc.wasm the way Quarto runs pandoc
  quarto-postprocess.js     port of Quarto's HTML post-processing
  jupyter-markdown.js       port of Quarto's Jupyter cell-to-markdown step
  build-quarto-runtime.mjs  captures a real Quarto render into the runtime files
index.qmd, vignettes/       the website, built with the extension itself
tests/run.mjs               end-to-end tests against the rendered site
```

At lesson render time, the filter replaces each `quarto-simulator` block with
a container holding the block's options and starting document as JSON, and
adds the resources as an HTML dependency. In the browser,
`quarto-simulator.js` finds the containers and builds the playgrounds.

A render in the browser follows `quarto render`: parse the YAML, run the code
cells into the intermediate markdown Quarto's engines produce, run pandoc
with Quarto's Lua filters, post-process the HTML, and show it in a sandboxed
iframe. [How it works](https://ryjohnson09.github.io/quarto-simulator/vignettes/how-it-works.html)
explains which steps are real Quarto and which are reimplemented.

## Building

The generated files are committed so that `quarto add` works without a
toolchain.

```bash
npm run build      # vendor.js, after changing anything in tools/vendor/
```

The runtime files are captured from a Quarto installation. **Its pandoc
version must match pandoc-wasm's** (pandoc 3.10 for pandoc-wasm 1.1.0, so
Quarto 1.10.x); Quarto's Lua filters are written for one pandoc version.

```bash
QUARTO=/path/to/quarto-1.10.x/bin/quarto npm run build:runtime
```

The script renders a small document through a logging stand-in for pandoc,
records what Quarto passed to it, and packs that with Quarto's Lua files. It
refuses to write the bundle if any local path (a home folder, a temporary
directory) would end up in it.

## Tests

```bash
quarto render && npm test
```

`tests/run.mjs` serves `_site/` and drives it in Chromium: every playground on
every page must render (or fail, where failing is the point), every exercise
in the example lesson must reject its starting document and accept its
solution, plots must load, and Python must be stoppable. It needs a network
connection, because pandoc, webR and Pyodide come from CDNs. Set
`BROWSER_CHANNEL=chrome` to use an installed Chrome.

When you change how documents render, also compare with native Quarto: render
the same document with `quarto render` and in a playground, and diff the
`<main>` elements. Differences should be deliberate and listed in the How it
works vignette.

## Things that will surprise you

**Lessons need `engine: markdown`.** Otherwise knitr or Jupyter runs the code
cells inside playground blocks while the lesson renders. The filter warns when
it sees evidence of this.

**pandoc's language lookup is slow for aliases.** A code block whose language
pandoc doesn't know by its full name makes it decode every syntax definition,
about a second in wasm. That is why the build renames Quarto's R syntax
definition to `r`.

**The preview iframe is sandboxed** (no `allow-same-origin`), so it can't load
module scripts or use `localStorage`. `quarto.js` is bundled into a classic
script and Web Storage is replaced with an in-memory store.

**Python runs in a worker, R doesn't need to.** webR already runs R in its own
worker. Pyodide would run on the page's main thread, so `python-worker.js`
moves it into a worker; terminating the worker is how **Stop** works.

## Style

- Two-space indentation, no semicolons in JavaScript.
- Comments explain *why*, not what. If a line looks wrong but is deliberate,
  say why.
- Messages are read by learners and lesson authors, not programmers. Say what
  is wrong and what to do, in plain words.

## Releasing

1. Update `CHANGELOG.md`.
2. Bump the version in `_extensions/quarto-simulator/_extension.yml`,
   `package.json`, and the `version` passed to `add_html_dependency` in
   `quarto-simulator.lua` (it names the folder the resources are copied to).
3. Commit, then tag: `git tag v0.4.0 && git push --tags`.

`quarto add ryjohnson09/quarto-simulator` installs from the **HEAD of `main`**,
not from the latest tag, so keep `main` releasable and the generated files
current. Users who want a fixed version can install a tag:

```bash
quarto add ryjohnson09/quarto-simulator@v0.4.0
```
