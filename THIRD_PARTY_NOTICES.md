# Third-party notices

quarto-simulator's own code is MIT licensed (see `LICENSE`). The extension
also contains, or downloads at runtime, third-party software under its own
licenses.

## Bundled in `_extensions/quarto-simulator/resources/vendor.js`

- [CodeMirror 6](https://codemirror.net) and [Lezer](https://lezer.codemirror.net),
  with their dependencies `crelt`, `style-mod` and `w3c-keyname` (MIT)
- [js-yaml](https://github.com/nodeca/js-yaml) (MIT)
- [ansi_up](https://github.com/drudru/ansi_up) (MIT)
- [browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) (MIT or Apache-2.0)

`tools/vendor/jupyter-markdown.js` and `tools/vendor/quarto-postprocess.js`,
also bundled into `vendor.js`, are ported from
[quarto-cli](https://github.com/quarto-dev/quarto-cli) (MIT,
Copyright Posit Software, PBC).

## Copied from Quarto 1.10.19

`resources/quarto-runtime.json` and `resources/quarto-libs/` hold files from
a Quarto installation. Quarto is MIT licensed (Copyright Posit Software,
PBC). Some of the files it ships have their own licenses:

- Bootstrap and Bootstrap Icons, clipboard.js, AnchorJS, Popper and tippy.js
  (all MIT), in `quarto-libs/`
- KDE syntax definitions in `quarto-runtime.json`, under the licenses in
  their headers: `r.xml` (GPLv2), `k.xml` and `q.xml` (LGPLv2+),
  `scss.xml` (LGPL) and `markdown.xml` (GPL or BSD). quarto-simulator changes
  one line of `r.xml`: the language's `name` is "r" instead of "R Script",
  so that pandoc finds it quickly.

## Downloaded at runtime, not included

- [pandoc](https://pandoc.org), as [pandoc-wasm](https://github.com/pandoc/pandoc-wasm)
  (GPL-2.0-or-later), run as a separate program through its standard WASI
  command interface
- [webR](https://docs.r-wasm.org/webr/), whose binaries are distributed
  under GPL-3 because they include R, and R packages from the webR
  repository under their own licenses
- [Pyodide](https://pyodide.org) (MPL-2.0), IPython (BSD-3-Clause), and
  Python packages under their own licenses
