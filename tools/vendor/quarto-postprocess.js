// HTML post-processing that `quarto render` applies after pandoc runs.
//
// Ported from Quarto CLI 1.9 (MIT license): htmlFormatPostprocessor and
// bootstrapHtmlPostprocessor in src/format/html/. Only the steps that apply
// to a single standalone HTML document are included.
//
// `toc` holds the document's `toc-location`, `toc-depth` and `toc-expand`.

export function postprocess(doc, { codeCopy = true, anchors = true, copyTooltip = "Copy to Clipboard", toc: tocOptions = {} } = {}) {
  // htmlFormatPostprocessor -------------------------------------------------------

  for (const code of doc.querySelectorAll("pre.sourceCode")) {
    for (const cls of ["cell-code", "hidden"]) {
      if (code.classList.contains(cls)) {
        code.classList.remove(cls)
        code.parentElement?.classList.add(cls)
      }
    }
    if (codeCopy) {
      const scaffold = doc.createElement("div")
      scaffold.classList.add("code-copy-outer-scaffold")
      const button = doc.createElement("button")
      button.setAttribute("title", copyTooltip)
      button.classList.add("code-copy-button")
      const icon = doc.createElement("i")
      icon.classList.add("bi")
      button.appendChild(icon)
      code.classList.add("code-with-copy")
      const sourceDiv = code.parentElement
      sourceDiv.parentElement.replaceChild(scaffold, sourceDiv)
      scaffold.appendChild(sourceDiv)
      scaffold.appendChild(button)
    }
  }

  if (anchors) {
    const container = doc.querySelector("main") || doc.body
    for (const selector of ["h2", "h3", "h4", "h5", "h6", ".quarto-figure[id]", "div[id^=tbl-]"]) {
      for (const heading of container.querySelectorAll(selector)) {
        if (heading.id !== "toc-title" && !heading.classList.contains("no-anchor")) {
          heading.classList.add("anchored")
        }
      }
    }
  }

  for (const number of doc.querySelectorAll(".header-section-number")) {
    if (number.previousElementSibling?.classList.contains("toc-section-number")) number.remove()
  }

  for (const table of doc.querySelectorAll('table[data-quarto-postprocess="true"]')) {
    if (table.getAttribute("data-quarto-disable-processing") === "true") continue
    table.removeAttribute("data-quarto-postprocess")
    table.removeAttribute("data-quarto-disable-processing")
    for (const row of table.querySelectorAll("tr")) {
      for (const cell of [...row.children]) {
        if (cell.tagName !== "TH" && cell.tagName !== "TD") continue
        const replacement = doc.createElement(cell.getAttribute("data-quarto-table-cell-role") === "th" ? "th" : "td")
        while (cell.firstChild) replacement.appendChild(cell.firstChild)
        for (const attr of cell.attributes) replacement.setAttribute(attr.name, attr.value)
        cell.replaceWith(replacement)
      }
    }
  }

  // bootstrapHtmlPostprocessor ----------------------------------------------------------

  doc.querySelector("header > .title")?.classList.add("display-7")
  doc.querySelector("header > .subtitle")?.classList.add("lead")
  for (const quote of doc.querySelectorAll("blockquote")) quote.classList.add("blockquote")
  for (const figure of doc.querySelectorAll("figure")) {
    figure.classList.add("figure")
    for (const img of figure.querySelectorAll("img")) img.classList.add("figure-img")
  }
  for (const img of doc.querySelectorAll(".column-margin .cell-output-display img:not(.img-fluid)")) {
    img.classList.add("img-fluid")
  }

  // Quarto's before-body template holds a #quarto-toc-target in the sidebar
  // for the TOC's location; the runtime's template was captured without one,
  // so add it here.
  const tocLocation = tocOptions.location ?? "right"
  const content = doc.getElementById("quarto-content")
  if (doc.querySelector('nav[role="doc-toc"]') && content) {
    const target = doc.createElement("div")
    target.id = "quarto-toc-target"
    if (tocLocation === "left" || tocLocation === "left-body") {
      content.classList.add("toc-left")
      const sidebar = doc.createElement("div")
      sidebar.id = "quarto-sidebar-toc-left"
      sidebar.className = "sidebar toc-left"
      sidebar.append(target)
      content.prepend(sidebar)
    } else if (tocLocation === "right" || tocLocation === "right-body") {
      doc.getElementById("quarto-margin-sidebar")?.append(target)
    }
  }

  const toc = doc.querySelector('nav[role="doc-toc"]')
  const tocTarget = doc.getElementById("quarto-toc-target")
  if (toc && tocTarget) {
    if (tocLocation.includes("-body")) {
      const bodyToc = toc.cloneNode(true)
      bodyToc.id = "TOC-body"
      bodyToc.querySelector(".toc-actions")?.remove()
      toc.parentElement?.insertBefore(bodyToc, toc)
    }
    toc.classList.add("toc-active")
    const expanded = tocOptions.expand
    if (expanded !== undefined) {
      toc.setAttribute("data-toc-expanded", expanded === true ? 99 : expanded ? expanded : -1)
    }
    doc.querySelectorAll('nav#TOC[role="doc-toc"] > ul a').forEach((link, i) => {
      link.classList.add("nav-link")
      if (i === 0) link.classList.add("active")
      if (!link.hasAttribute("data-scroll-target")) {
        link.setAttribute("data-scroll-target", link.getAttribute("href")?.replaceAll(":", "\\:"))
      }
    })
    const depth = tocOptions.depth || 3
    if (depth > 1) {
      for (const ul of toc.querySelectorAll("ul ".repeat(depth - 1).trim())) ul.classList.add("collapse")
    }
    toc.remove()
    tocTarget.replaceWith(toc)
  } else {
    tocTarget?.remove()
  }

  const inCell = el => el.closest(".cell:not(.plain)") !== null
  for (const row of doc.querySelectorAll("tbody > tr:first-child.odd")) {
    const table = row.parentNode?.parentNode
    if (!table) continue
    table.removeAttribute("style")
    table.classList.add("table")
    if (inCell(table)) table.classList.add("table-sm", "table-striped", "small")
  }
  // pandas DataFrames: drop the inline styles pandas emits.
  for (const table of doc.querySelectorAll("table.dataframe")) {
    table.removeAttribute("border")
    table.classList.add("table", "table-sm", "table-striped", "small")
    for (const row of table.querySelectorAll("tr")) row.removeAttribute("style")
    if (table.previousElementSibling?.tagName === "STYLE") table.previousElementSibling.remove()
  }
  for (const table of doc.querySelectorAll("table.data-frame")) {
    table.classList.add("table", "table-sm", "table-striped", "small")
  }

  for (const section of doc.querySelectorAll('section[class^="level"]')) {
    const heading = section.querySelector("h2") || section.querySelector("h3") || section.querySelector("h4") ||
      section.querySelector("h5") || section.querySelector("h6")
    if (heading) heading.setAttribute("data-anchor-id", section.id)
  }

  const beforeBody = doc.querySelector("script#quarto-html-before-body")
  if (beforeBody) doc.body.insertBefore(beforeBody, doc.body.firstChild)
}
