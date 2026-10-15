// The markdown Quarto's Jupyter engine writes for an executed code cell,
// ported from quarto-cli (MIT): mdFromCodeCell and its helpers in
// src/core/jupyter/jupyter.ts, and inline expressions from
// src/core/jupyter/jupyter-inline.ts (Quarto 1.10).
//
// Differences from Quarto: figures are not written to files. Each image is
// pushed onto `images` as a data URL and referenced by a placeholder name,
// which the renderer swaps for the data URL after pandoc runs.

import { AnsiUp } from "ansi_up"

const kTextPlain = "text/plain"
const kTextHtml = "text/html"
const kTextMarkdown = "text/markdown"
const kTextLatex = "text/latex"
const kImagePng = "image/png"
const kImageJpeg = "image/jpeg"
const kImageSvg = "image/svg+xml"
const kApplicationPdf = "application/pdf"
const kApplicationJavascript = "application/javascript"
const kWidgetState = "application/vnd.jupyter.widget-state+json"
const kWidgetView = "application/vnd.jupyter.widget-view+json"

// Cell options Quarto handles itself; any other option is forwarded to the
// cell div as an attribute (for example `tbl-cap`).
const kCellOptionsFilter = [
  "eval", "echo", "warning", "error", "output", "include", "label", "classes",
  "panel", "column", "fig-cap", "fig-subcap", "fig-scap", "fig-cap-location",
  "tbl-cap-location", "cap-location", "fig-column", "tbl-column", "fig-link",
  "fig-align", "fig-alt", "fig-env", "fig-pos", "lst-label", "lst-cap",
  "out-width", "out-height", "md-indent", "code-fold", "code-line-numbers",
  "code-summary", "code-overflow", "html-table-processing",
  "collapsed", "autoscroll", "deletable", "format", "name",
  "id", "colab", "colab_type", "outputid", "lines_to_next_cell", "language"
]

// Strings or nbformat line arrays, as lines that keep their "\n".
const asLines = value => {
  const text = Array.isArray(value) ? value.join("") : String(value ?? "")
  return text.match(/[^\n]*\n|[^\n]+$/g) || []
}
const asText = value => (Array.isArray(value) ? value.join("") : String(value ?? ""))

const countTicks = lines => Math.max(0, ...lines.map(s => (s.match(/^\s*`+/)?.[0].length ?? 0)))
const ticksForCode = lines => "`".repeat(Math.max(3, countTicks(lines) + 1))

function pandocAutoIdentifier(text) {
  return text.replace(/[!"#$%&')*+,\/:;<=>?@\[\\\]^`{|}~]/g, "").replace(/\s/g, "-").toLowerCase().replace(/^[^A-Za-z]+/, "")
}

function trimEmptyLines(lines, trim = "all") {
  if (trim === "all" || trim === "leading") {
    const first = lines.findIndex(line => line.trim().length > 0)
    if (first === -1) return []
    lines = lines.slice(first)
  }
  if (trim === "all" || trim === "trailing") {
    let last = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().length > 0) {
        last = i
        break
      }
    }
    if (last > -1) lines = lines.slice(0, last + 1)
  }
  return lines
}

const isDisplayData = output => ["display_data", "execute_result"].includes(output.output_type)
const isCaptionableData = output => isDisplayData(output) && !output.noCaption
const hasTableLabel = options => typeof options.label === "string" && options.label.startsWith("tbl-")
const displayDataIsImage = mime => [kImagePng, kImageJpeg, kImageSvg, kApplicationPdf].includes(mime)

function displayDataMimeType(output) {
  // HTML output: Quarto's priority list for `toHtml`.
  const priority = [
    kWidgetState, kWidgetView, kApplicationJavascript, kTextHtml,
    kTextMarkdown, kImageSvg, kImagePng, kImageJpeg,
    kWidgetState, kWidgetView, kApplicationJavascript, kTextHtml,
    kTextPlain
  ]
  const available = Object.keys(output.data)
  return priority.find(mime => available.includes(mime)) ?? null
}
const isImage = output => isDisplayData(output) && displayDataIsImage(displayDataMimeType(output))
const isMarkdown = output => isDisplayData(output) && displayDataMimeType(output) === kTextMarkdown

function shouldInclude(cell, options, context) {
  return cell.options[context] !== undefined ? !!cell.options[context] : !!options.execute[context]
}
const includeCell = (cell, options) => shouldInclude(cell, options, "include")
const includeCode = (cell, options) => shouldInclude(cell, options, "echo")
const includeOutput = (cell, options) => shouldInclude(cell, options, "output")
function includeWarnings(cell, options) {
  if (options.execute.output === false && cell.options.output !== false) return cell.options.warning || false
  return shouldInclude(cell, options, "warning")
}

function cellLabel(cell) {
  const label = pandocAutoIdentifier(String(cell.options.label || ""))
  return label && !label.startsWith("#") ? "#" + label : label
}

function shouldLabelCellContainer(cell, outputs, options) {
  if (!outputs || !includeOutput(cell, options)) return true
  const displayOutputs = outputs.filter(isDisplayData)
  if (displayOutputs.length === 0) return true
  if (displayOutputs.length > 1 && !Array.isArray(cell.options["fig-cap"])) return true
  return hasTableLabel(cell.options)
}

function shouldLabelOutputContainer(output, cellOptions) {
  if (!isDisplayData(output) || hasTableLabel(cellOptions) || !isCaptionableData(output)) return false
  return !displayDataIsImage(displayDataMimeType(output))
}

function resolveCaptions(cell) {
  const figCap = cell.options["fig-cap"]
  if (Array.isArray(figCap)) {
    return { cellCaption: undefined, outputCaptions: cell.outputs.some(isCaptionableData) ? [...figCap] : [] }
  } else if (figCap) {
    let subCap = cell.options["fig-subcap"]
    if (subCap === undefined) return { cellCaption: undefined, outputCaptions: [figCap] }
    if (subCap === true) subCap = [""]
    if (!Array.isArray(subCap)) subCap = [String(subCap)]
    return { cellCaption: figCap, outputCaptions: subCap }
  }
  return { cellCaption: undefined, outputCaptions: [] }
}

function isDiscardableTextExecuteResult(output, haveImage) {
  if (output.output_type !== "execute_result" || Object.keys(output.data).length !== 1) return false
  const textPlain = output.data[kTextPlain] && asLines(output.data[kTextPlain])
  if (!textPlain?.length) return false
  if (haveImage) {
    if (textPlain.length === 1) {
      const first = textPlain[0].trim()
      return /^([<(\[]).*?([>)\]])$/.test(first) || /^Text\([-\d]/.test(first) || (first.startsWith("{") && first.includes("<matplotlib."))
    }
    return textPlain.some(line => line.includes("<matplotlib."))
  }
  return ["[<matplotlib", "<matplotlib", "<seaborn.", "<ggplot:"].some(prefix => textPlain[0].startsWith(prefix))
}

const hasAnsiEscapeCodes = text => /\x1b\[\d+(?:;\d+)*m/.test(text)
const stripAnsiCode = text => text.replace(/\x1b\[[0-9;]*m/g, "")

// ansi_up with classes, then bold spans get the `ansi-bold` class, as in
// Quarto's convertToHtmlSpans (which re-serializes the HTML, unescaping quotes).
function convertToHtmlSpans(text) {
  const ansi = new AnsiUp()
  ansi.use_classes = true
  return ansi.ansi_to_html(text)
    .replace(/<span(?: class="([^"]*)")? style="font-weight:bold">/g, (_, cls) => `<span class="${cls ? cls + " " : ""}ansi-bold">`)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
}

const ansiOutput = html => `\n::: {.ansi-escaped-output}\n\`\`\`{=html}\n<pre>${html}</pre>\n\`\`\`\n:::\n`

function mdEnclosedOutput(begin, lines, end) {
  const output = lines.join("")
  return `${begin}\n${output}${output.endsWith("\n") ? "" : "\n"}${end}\n`
}
const mdCodeOutput = lines => {
  const ticks = ticksForCode(lines)
  return mdEnclosedOutput(ticks, lines, ticks)
}
const mdFormatOutput = (format, lines) => {
  const ticks = ticksForCode(lines)
  return mdEnclosedOutput(`${ticks}{=${format}}`, lines, ticks)
}
const mdMarkdownOutput = lines => lines.join("") + "\n"

function mdOutputStream(output) {
  let text = asLines(output.text)
  if (output.name === "stderr" && text[0]) {
    text = [text[0].replace(/<ipython-input.*?>:\d+:\s+/, ""), ...text.slice(1)]
  }
  if (text.some(hasAnsiEscapeCodes)) return mdMarkdownOutput([ansiOutput(convertToHtmlSpans(text.join("\n")))])
  return mdCodeOutput(text.map(stripAnsiCode))
}

function mdOutputError(output) {
  const traceback = output.traceback.join("\n")
  if (!hasAnsiEscapeCodes(output.evalue) && !hasAnsiEscapeCodes(traceback)) {
    return mdCodeOutput([`${output.ename}: ${output.evalue}${output.traceback.length ? "\n" + traceback : ""}`])
  }
  return mdMarkdownOutput([ansiOutput(convertToHtmlSpans(traceback))])
}

function mdImageOutput(label, caption, mimeType, output, figureOptions, images) {
  const data = output.data[mimeType]
  const metadata = output.metadata?.[mimeType]
  const value = (key, fallback) => (metadata && metadata[key] ? metadata[key] : fallback)
  const width = value("out-width") ?? value("width", 0)
  const height = value("out-height") ?? value("height", 0)
  const text = asText(data).trim()
  if (mimeType === kImageSvg && /<svg/.test(text)) {
    images.push(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`)
  } else {
    images.push(`data:${mimeType};base64,${text.replace(/\n/g, "")}`)
  }
  const extension = { [kImagePng]: "png", [kImageJpeg]: "jpg", [kImageSvg]: "svg", [kApplicationPdf]: "pdf" }[mimeType]
  const file = `qp-img-${images.length}.${extension}`

  const figOptions = ["fig-align", "fig-env", "fig-alt", "fig-pos", "fig-scap"]
  let image = `![${caption || ""}](${file})`
  if (label || width || height || Object.keys(figureOptions).some(option => figOptions.includes(option))) {
    image += "{"
    if (label) image += `${label} `
    if (width) image += `width=${width} `
    if (height) image += `height=${height} `
    for (const option of figOptions) {
      if (figureOptions[option]) image += `${option}='${String(figureOptions[option]).replaceAll("'", "\\'")}' `
    }
    image = image.trimEnd() + "}"
  }
  if (figureOptions["fig-link"]) image = `[${image}](${figureOptions["fig-link"]})`
  return mdMarkdownOutput([image])
}

function mdOutputDisplayData(label, caption, output, figureOptions, images) {
  const mimeType = displayDataMimeType(output)
  if (mimeType) {
    const data = output.data[mimeType]
    if (displayDataIsImage(mimeType)) return mdImageOutput(label, caption, mimeType, output, figureOptions, images)
    if (mimeType === kTextMarkdown) return mdMarkdownOutput(asLines(data))
    if (mimeType === kTextLatex) return mdFormatOutput("tex", asLines(data))
    if (mimeType === kTextHtml) return mdFormatOutput("html", asLines(data))
    if (mimeType === kWidgetState || mimeType === kWidgetView) {
      return mdFormatOutput("html", [`<script type="${mimeType}">\n`, JSON.stringify({ ...data, "quarto-mime-type": mimeType }), "\n</script>"])
    }
    if (mimeType === kApplicationJavascript) {
      return mdFormatOutput("html", [`<script type="${mimeType}">\n`, ...asLines(data), "\n</script>"])
    }
    if (mimeType === kTextPlain) {
      const lines = asLines(data)
      if (lines.length === 1 && lines[0].startsWith("'<table") && lines[0].endsWith("</table>'")) {
        return mdMarkdownOutput([lines[0].slice(1, -1)])
      }
      if (lines.some(hasAnsiEscapeCodes)) return mdMarkdownOutput([ansiOutput(lines.map(convertToHtmlSpans).join(""))])
      return mdCodeOutput(lines)
    }
  }
  return mdOutputStream({ name: "stderr", text: "Unable to display output for mime type(s): " + Object.keys(output.data).join(", ") })
}

// cell: { id, source, optionsSource, options, outputs, execution_count }
//   source: the code without its `#|` lines; optionsSource: those lines;
//   options: only the options set on the cell.
// options: { execute, language }, where execute holds the document's
//   echo/eval/output/warning/error/include settings.
export function jupyterCellMarkdown(cell, cellIndex, options, images) {
  if (!includeCell(cell, options)) return ""
  const haveImage = cell.outputs.some(isImage)
  const outputs = cell.outputs.filter(output => {
    if (output.output_type === "stream" && output.name === "stderr" && !includeWarnings(cell, options)) return false
    return !isDiscardableTextExecuteResult(output, haveImage)
  })
  const sourceLines = asLines(cell.source)
  if (!sourceLines.length && !outputs.length) return ""

  const asis = cell.options.output === "asis" || (options.execute.output === "asis" && cell.options.output === undefined)
  const md = []
  const divMd = ["::: {"]
  const label = cellLabel(cell)
  const labelCellContainer = shouldLabelCellContainer(cell, outputs, options)
  if (label && labelCellContainer) divMd.push(`${label} `)
  else if (cell.id) divMd.push(`#${cell.id} `)

  let { cellCaption, outputCaptions } = resolveCaptions(cell)
  outputCaptions = outputCaptions.map(caption => String(caption).trim().replaceAll("\n", " "))
  divMd.push(".cell ")

  const classes = [].concat(cell.options.classes ?? [])
  const prefixed = { panel: "panel-", column: "column-", "fig-column": "fig-column-", "tbl-column": "tbl-column-" }
  for (const [option, prefix] of Object.entries(prefixed)) {
    if (typeof cell.options[option] === "string") classes.push(`${prefix}${cell.options[option]}`)
  }
  // (Quarto writes `caption-` from fig-cap-location here; kept as is.)
  if (typeof cell.options["cap-location"] === "string") classes.push(`caption-${cell.options["fig-cap-location"]}`)
  if (typeof cell.options["fig-cap-location"] === "string") classes.push(`fig-cap-location-${cell.options["fig-cap-location"]}`)
  if (typeof cell.options["tbl-cap-location"] === "string") classes.push(`tbl-cap-location-${cell.options["tbl-cap-location"]}`)
  if (classes.length > 0) {
    divMd.push(classes.map(c => (String(c).startsWith(".") ? c : "." + c)).join(" ") + " ")
  }

  let forwardedAttrs = false
  for (const [key, raw] of Object.entries(cell.options)) {
    if (kCellOptionsFilter.includes(key.toLowerCase()) || raw === undefined) continue
    const value = (typeof raw === "string" ? raw : JSON.stringify(raw)).replaceAll("'", "\\'")
    divMd.push(`${key}='${value}' `)
    forwardedAttrs = true
  }
  const needCell = (label && labelCellContainer) || classes.length > 0 || forwardedAttrs ||
    cellCaption !== undefined || outputCaptions.length > 0
  if (typeof cell.execution_count === "number") divMd.push(`execution_count=${cell.execution_count} `)
  const divBeginMd = divMd.join("").replace(/ $/, "") + "}\n"

  if (includeCode(cell, options)) {
    const fenced = cell.options.echo === "fenced" || (cell.options.echo === undefined && options.execute.echo === "fenced")
    const ticks = "`".repeat(Math.max(countTicks(sourceLines) + 1, fenced ? 4 : 3))
    md.push(ticks + " {")
    if (typeof cell.options["lst-label"] === "string") {
      md.push((cell.options["lst-label"].startsWith("#") ? "" : "#") + cell.options["lst-label"] + " ")
    }
    if (!fenced) md.push("." + options.language)
    md.push(" .cell-code")
    if (cell.options["code-overflow"] === "wrap") md.push(" .code-overflow-wrap")
    else if (cell.options["code-overflow"] === "scroll") md.push(" .code-overflow-scroll")
    if (typeof cell.options["lst-cap"] === "string") md.push(` lst-cap="${cell.options["lst-cap"]}"`)
    if (cell.options["code-fold"] !== undefined) md.push(` code-fold="${cell.options["code-fold"]}"`)
    if (cell.options["code-summary"] !== undefined) md.push(` code-summary="${cell.options["code-summary"]}"`)
    if (cell.options["code-line-numbers"] !== undefined) md.push(` code-line-numbers="${cell.options["code-line-numbers"]}"`)
    md.push("}\n")
    let source = [...sourceLines]
    if (fenced) {
      const optionsSource = cell.optionsSource.filter(line => line.search(/\|\s+echo:\s+fenced\s*$/) === -1)
      source = trimEmptyLines(source, optionsSource.length > 0 ? "trailing" : "all")
      source.unshift(...optionsSource)
      source.unshift("```{{" + options.language + "}}\n")
      source.push("\n```\n")
    } else if (cell.optionsSource.length > 0) {
      source = trimEmptyLines(source, "leading")
    }
    md.push(...source, "\n")
    md.push(ticks + "\n")
  }

  if (includeOutput(cell, options)) {
    let nextOutputSuffix = 1
    outputs.forEach((output, index) => {
      const outputLabel = label && labelCellContainer && isDisplayData(output) ? label + "-" + nextOutputSuffix++ : label
      if (!asis) {
        md.push("\n::: {")
        if (outputLabel && shouldLabelOutputContainer(output, cell.options)) md.push(outputLabel + " ")
        md.push(".cell-output ")
        md.push(output.output_type === "stream"
          ? `.cell-output-${output.name}`
          : `.cell-output-${isDisplayData(output) ? "display" : output.output_type}`)
        if (isMarkdown(output)) md.push(" .cell-output-markdown")
        if (typeof output.execution_count === "number") md.push(` execution_count=${output.execution_count}`)
        if (cell.options["html-table-processing"] === "none") md.push(" html-table-processing=none")
        md.push("}\n")
      }
      const broadcast = name => {
        const value = cell.options[name]
        return value ? (Array.isArray(value) ? value[index] : value) : null
      }
      const figureOptions = {}
      for (const name of ["fig-align", "fig-scap", "fig-link", "fig-env", "fig-pos", "fig-alt"]) figureOptions[name] = broadcast(name)

      if (output.output_type === "stream") {
        md.push(asis && output.name === "stdout" ? asLines(output.text).join("") : mdOutputStream(output))
      } else if (output.output_type === "error") {
        md.push(mdOutputError(output))
      } else if (isDisplayData(output) && Object.keys(output.data).length > 0) {
        const caption = isCaptionableData(output) ? outputCaptions.shift() || null : null
        md.push(mdOutputDisplayData(outputLabel, caption, output, figureOptions, images))
        if (caption && !isImage(output)) md.push(`\n${caption}\n`)
      }
      if (!asis) md.push(":::\n")
    })
  }

  if (md.length > 0 && (needCell || !asis)) {
    md.unshift(divBeginMd)
    if (cellCaption) md.push("\n" + cellCaption + "\n")
    md.push(":::\n")
  }
  md.push("\n")
  return md.join("")
}

// The markdown for an inline `{python} expr` result: an IPython mime bundle.
export function jupyterInlineMarkdown(result) {
  const mimeType = displayDataMimeType(result)
  if (!mimeType) return ""
  const data = asText(result.data[mimeType])
  switch (mimeType) {
    case kTextHtml: return `\`${data}\`{=html}`
    case kTextLatex: return `\`${data}\`{=tex}`
    case kTextMarkdown: return data
    default: {
      // asEscapedMarkdown: strings print without their quotes.
      const quoted = (data.startsWith("'") && data.endsWith("'")) || (data.startsWith('"') && data.endsWith('"'))
      return quoted ? data.slice(1, -1).replace(/\\/g, "\\\\").replace(/([\\`*_{}\[\]()>#+-.!])/g, "\\$1") : data
    }
  }
}
