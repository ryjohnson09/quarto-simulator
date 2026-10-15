// Third-party code, plus the Quarto/pandoc runtime glue, bundled into a single
// ES module so the extension does not depend on CDN module resolution
// (CodeMirror breaks when two copies of @codemirror/state are loaded).
// Rebuild with `npm run build`.

import { EditorView, basicSetup } from "codemirror"
import { EditorState, RangeSetBuilder } from "@codemirror/state"
import { Decoration, ViewPlugin, keymap } from "@codemirror/view"
import { indentWithTab } from "@codemirror/commands"
import { HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting } from "@codemirror/language"
import { styleTags, tags as t } from "@lezer/highlight"
import { markdown } from "@codemirror/lang-markdown"
import { yamlFrontmatter } from "@codemirror/lang-yaml"
import { python } from "@codemirror/lang-python"
import { r } from "@codemirror/legacy-modes/mode/r"
import jsyaml from "js-yaml"
import { createQuartoPandoc } from "./quarto-pandoc.js"
import { postprocess } from "./quarto-postprocess.js"
import { jupyterCellMarkdown, jupyterInlineMarkdown } from "./jupyter-markdown.js"

// Fenced code inside the markdown gets highlighted when the info string
// names R or Python, including Quarto's executable `{r}` form.
const codeLanguages = [
  LanguageDescription.of({
    name: "r",
    alias: ["{r}", "R"],
    support: new LanguageSupport(StreamLanguage.define(r))
  }),
  LanguageDescription.of({
    name: "python",
    alias: ["{python}", "py"],
    support: python()
  })
]

function matchLanguage(info) {
  const name = info.replace(/^\{+|\}+$/g, "").split(/[\s,]/)[0].toLowerCase()
  return LanguageDescription.matchLanguageName(codeLanguages, name, true)
}

// Colours modelled on Positron's light theme (VS Code Light+): bold
// headings without underlines, maroon YAML keys, blue keywords and so on.
const positronHighlight = HighlightStyle.define([
  { tag: [t.heading1, t.heading2, t.heading3, t.heading4, t.heading5, t.heading6, t.heading], fontWeight: "bold", color: "#800000" },
  { tag: t.strong, fontWeight: "bold" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: [t.link, t.url], color: "#0451a5" },
  { tag: t.monospace, color: "#800000" },
  { tag: t.quote, color: "#0451a5" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "#808080" },
  { tag: t.definition(t.propertyName), color: "#800000" },
  { tag: t.keyword, color: "#0000ff" },
  { tag: [t.atom, t.bool, t.null], color: "#0000ff" },
  { tag: t.number, color: "#098658" },
  { tag: [t.string, t.special(t.string)], color: "#a31515" },
  { tag: t.comment, color: "#008000" },
  { tag: t.standard(t.variableName), color: "#795e26" },
  { tag: t.variableName, color: "#001080" },
  { tag: t.operator, color: "#000000" },
  { tag: t.labelName, color: "#001080" }
])

// Shade executable code cells (```{r} … ```), fences included, the way
// Positron shades cells in Quarto documents.
const CELL_OPEN = /^\s*(`{3,})\s*\{[A-Za-z]/
const cellLine = Decoration.line({ class: "cm-qp-cell" })

function cellDecorations(doc) {
  const builder = new RangeSetBuilder()
  let fence = null
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i)
    if (fence) {
      builder.add(line.from, line.from, cellLine)
      if (new RegExp(`^\\s*\`{${fence},}\\s*$`).test(line.text)) fence = null
    } else {
      const open = line.text.match(CELL_OPEN)
      if (open) {
        fence = open[1].length
        builder.add(line.from, line.from, cellLine)
      }
    }
  }
  return builder.finish()
}

const shadeCells = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = cellDecorations(view.state.doc) }
  update(update) { if (update.docChanged) this.decorations = cellDecorations(update.state.doc) }
}, { decorations: plugin => plugin.decorations })

export function createEditor({ parent, doc, onChange, onRender }) {
  const renderKeys = keymap.of([
    { key: "Mod-Shift-k", run: () => (onRender(), true) },
    { key: "Mod-Enter", run: () => (onRender(), true) }
  ])
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        renderKeys,
        basicSetup,
        keymap.of([indentWithTab]),
        EditorView.lineWrapping,
        yamlFrontmatter({
          content: markdown({
            codeLanguages: matchLanguage,
            // `##` takes the heading's colour, as in Positron, rather than the
            // grey used for other markdown punctuation.
            extensions: { props: [styleTags({ HeaderMark: t.heading })] }
          })
        }),
        syntaxHighlighting(positronHighlight),
        shadeCells,
        EditorView.updateListener.of(update => {
          if (update.docChanged) onChange(update.state.doc.toString())
        })
      ]
    })
  })
}

export function setEditorText(view, text) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
}

export { jsyaml, createQuartoPandoc, postprocess, jupyterCellMarkdown, jupyterInlineMarkdown }
