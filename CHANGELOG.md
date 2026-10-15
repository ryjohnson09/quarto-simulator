# Changelog

## 0.4.0

Python support, and a website with vignettes.

- **Python cells run in the browser.** A Web Worker runs IPython in
  [Pyodide](https://pyodide.org), the same shell a Jupyter kernel uses, after
  Quarto's own kernel setup code. Outputs become markdown through a port of
  Quarto's Jupyter engine, so a Python-only document renders the same HTML as
  native Quarto 1.10.19.
- Imports load Pyodide's packages (numpy, pandas, matplotlib, …), or
  pure-Python packages from PyPI.
- Inline `` `{python} expr` `` code, evaluated as Quarto evaluates it.
- A **■ Stop** button appears when a Python cell runs for more than a moment.
  Stopping restarts Python; the page never freezes.
- Documents with R and Python run both, with approximate Python output.
- pandas tables get Quarto's table styling (a port of its pandas
  post-processing).
- A clear message when Python packages fail to download.
- The example lesson gains Exercise 4, on Python cells.
- A website on GitHub Pages with vignettes: Get started, Exercises, R code,
  Python code, an example lesson, and How it works.
- An end-to-end test suite (`npm test`) that drives every playground on the
  site in a browser, and CI workflows for the tests and the site.

## 0.3.0

- pandoc now runs as a command-line program (`pandoc --defaults …`) through
  its standard WASI entry point, the way Quarto runs it, in a fresh instance
  per render. No pandoc-wasm JavaScript is used or bundled.
- Quarto's settings reach its Lua filters as real environment variables, so
  the `os.getenv` workaround and the copied data-directory modules are gone.
- R code highlighting no longer costs about a second per render: Quarto's R
  syntax definition is named `r`, so pandoc finds it without searching.
- The first render is about 2 seconds faster.
- MIT license.

## 0.2.0

First published version, renamed from `qmd-playground` to make clear that
it simulates Quarto rather than being Quarto.

- `quarto-simulator` blocks: an editor with Positron-style highlighting and
  shaded code cells, and a preview labelled **Preview (simulated Quarto)**.
- Markdown to HTML with Quarto 1.10.19's own reader, Lua filters, template
  and page assets, in pandoc 3.10 compiled to WebAssembly.
- R cells in webR, with an imitation of knitr's output: cell options, figures,
  cross-references, inline code and package installation.
- Exercises: hints, solutions with a copy button, and JavaScript checks.
- Helpful errors: YAML errors with line numbers, typo suggestions for
  options, and failed cells named with their lines.
