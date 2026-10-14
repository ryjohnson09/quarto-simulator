-- quarto-simulator.lua
--
-- Lesson-time filter. Turns authoring syntax into playground widgets:
--
--   ````{quarto-simulator}        an editor + preview, starting from this text
--   #| exercise: ex1           (options as `#|` lines at the top)
--   ---
--   title: "Hello"
--   ---
--   ````
--
--   ```{quarto-simulator-check}             JavaScript that grades exercise `ex1`
--   #| exercise: ex1
--   if (!result.yaml.toc) return fail("Add `toc: true`.")
--   ```
--
--   ::: {.hint exercise="ex1"}      revealed by the Hint button
--   ::: {.solution exercise="ex1"}  revealed by the Show solution button

local playground_count = 0
local exercises = {}
local default_column = nil

local function is_block(el, name)
  return el.classes:includes("{" .. name .. "}") or el.classes:includes(name)
end

local function plain(value)
  local kind = pandoc.utils.type(value)
  if kind == "boolean" or kind == "number" or kind == "string" then
    return value
  elseif kind == "Inlines" or kind == "Blocks" then
    return pandoc.utils.stringify(value)
  elseif kind == "List" then
    local out = {}
    for i, v in ipairs(value) do out[i] = plain(v) end
    return out
  elseif kind == "table" or kind == "Meta" then
    local out = {}
    for k, v in pairs(value) do out[k] = plain(v) end
    return out
  end
  return pandoc.utils.stringify(value)
end

-- Splits leading `#| key: value` lines from the rest of the text.
local function split_options(text)
  local option_lines = {}
  local rest = {}
  local in_options = true
  for line in (text .. "\n"):gmatch("(.-)\r?\n") do
    if in_options and line:match("^#|") then
      table.insert(option_lines, (line:gsub("^#|%s?", "")))
    else
      in_options = false
      table.insert(rest, line)
    end
  end
  local options = {}
  if #option_lines > 0 then
    local meta = pandoc.read("---\n" .. table.concat(option_lines, "\n") .. "\n---\n", "markdown").meta
    for k, v in pairs(meta) do options[k] = plain(v) end
  end
  return options, table.concat(rest, "\n")
end

local function json_script(class, data, attrs)
  -- `<` is escaped so the payload can never close the script element.
  local json = pandoc.json.encode(data):gsub("<", "\\u003c")
  return string.format('<script type="application/json" class="%s"%s>%s</script>', class, attrs or "", json)
end

local function read_file(path)
  local base = pandoc.path.directory(quarto.doc.input_file)
  local full = pandoc.path.join({ base, path })
  local handle = io.open(full, "r")
  if not handle then
    error("quarto-simulator: cannot read starter file '" .. full .. "'")
  end
  local text = handle:read("a")
  handle:close()
  return (text:gsub("\n$", ""))
end

local function playground(block)
  local options, source = split_options(block.text)
  if options.file then
    source = read_file(options.file)
  end
  if source:find("::: {.cell}", 1, true) and source:find("cell-output", 1, true) then
    quarto.log.warning(
      "quarto-simulator: a playground's code cells were executed while rendering the lesson. " ..
      "Add `engine: markdown` to the lesson's YAML, or move the starter document into a file " ..
      "and use `#| file: _starter.qmd`.")
  end

  if not quarto.doc.is_format("html") then
    return pandoc.CodeBlock(source, pandoc.Attr("", { "markdown" }))
  end

  playground_count = playground_count + 1
  local id = options.exercise or ("playground-" .. playground_count)
  if options.exercise then exercises[options.exercise] = true end
  local config = { id = id, source = source, options = options }
  -- `#| column: page` etc. widens the playground using Quarto's page layout
  -- classes; the default stays in the body column so it can't collide with
  -- a margin table of contents.
  local column = options.column or default_column
  column = column and (" column-" .. column) or ""
  return pandoc.RawBlock("html",
    '<div class="quarto-simulator' .. column .. '" id="quarto-simulator-' .. id .. '">' ..
    json_script("quarto-simulator-config", config) ..
    "</div>")
end

local function check(block)
  local options, code = split_options(block.text)
  if not options.exercise then
    quarto.log.warning("quarto-simulator: a {quarto-simulator-check} block needs `#| exercise: <id>`; it was ignored.")
    return {}
  end
  if not quarto.doc.is_format("html") then return {} end
  return pandoc.RawBlock("html", json_script("quarto-simulator-check", { code = code },
    ' data-exercise="' .. options.exercise .. '"'))
end

local function hint_or_solution(div, kind)
  local exercise = div.attributes.exercise
  if not exercise or not exercises[exercise] then return nil end
  kind = kind or (div.classes:includes("hint") and "hint") or (div.classes:includes("solution") and "solution")
  if not kind then return nil end
  if not quarto.doc.is_format("html") then return {} end
  return pandoc.Div(div.content, pandoc.Attr("", { "quarto-simulator-" .. kind }, {
    ["data-exercise"] = exercise,
    hidden = ""
  }))
end

local function add_dependency(meta)
  local resources = {
    "resources/vendor.js",
    "resources/quarto-runtime.json",
    "resources/preview-frame.css"
  }
  -- Quarto's own HTML dependencies for the preview, keeping their folder
  -- layout (quarto.js imports ./tabsets/tabsets.js).
  local lib_files = dofile(quarto.utils.resolve_path("resources/quarto-libs.lua"))
  for _, file in ipairs(lib_files) do
    table.insert(resources, { name = "quarto-libs/" .. file, path = "resources/quarto-libs/" .. file })
  end
  quarto.doc.add_html_dependency({
    name = "quarto-simulator",
    version = "0.3.0",
    scripts = { { path = "resources/quarto-simulator.js", attribs = { type = "module" } } },
    stylesheets = { "resources/quarto-simulator.css" },
    resources = resources
  })
  -- Optional document-level settings:
  --   quarto-simulator:
  --     column: page-inset-right     # default width for every playground
  --     pandoc-wasm-url: /assets/pandoc.wasm
  --     webr-url: https://webr.r-wasm.org/v0.6.0/webr.mjs
  local config = meta["quarto-simulator"]
  if config then
    local settings = {}
    local keys = { ["pandoc-wasm-url"] = "pandocWasmUrl", ["webr-url"] = "webrUrl" }
    for key, name in pairs(keys) do
      if config[key] then settings[name] = pandoc.utils.stringify(config[key]) end
    end
    local json = pandoc.json.encode(settings):gsub("<", "\\u003c")
    quarto.doc.include_text("after-body",
      '<script type="application/json" id="quarto-simulator-settings">' .. json .. "</script>")
  end
end

return {
  {
    Meta = function(meta)
      local config = meta["quarto-simulator"]
      if config and config.column then default_column = pandoc.utils.stringify(config.column) end
    end
  },
  {
    -- Playgrounds before hints and solutions, so those can be matched to them.
    CodeBlock = function(block)
      if is_block(block, "quarto-simulator") then return playground(block) end
      if is_block(block, "quarto-simulator-check") then return check(block) end
    end
  },
  {
    Div = function(div) return hint_or_solution(div) end,
    -- Quarto parses `.solution` divs into proof environments (dropping the
    -- class) before extension filters run; unwrap those for playgrounds.
    Proof = function(proof)
      if proof.type:lower() == "solution" then return hint_or_solution(proof.div, "solution") end
    end,
    Meta = function(meta)
      if playground_count > 0 and quarto.doc.is_format("html") then add_dependency(meta) end
    end
  }
}
