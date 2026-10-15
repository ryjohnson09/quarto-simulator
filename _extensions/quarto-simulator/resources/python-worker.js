// quarto-simulator: a Python "kernel" in a Web Worker, so long-running code
// never freezes the lesson page. Pyodide runs IPython's InteractiveShell, the
// same machinery a Jupyter kernel uses: cells produce Jupyter outputs
// (streams, execute_result, display_data, error) that the page turns into
// markdown the way Quarto's Jupyter engine does.

const KERNEL = String.raw`
import base64, io, json, os, sys
os.environ["MPLBACKEND"] = "module://matplotlib_inline.backend_inline"

from traitlets.config import Config
from IPython.core.interactiveshell import InteractiveShell
from IPython.core.displayhook import DisplayHook
from IPython.core.displaypub import DisplayPublisher

_outputs = []

def _clean(value):
    if isinstance(value, bytes):
        return base64.b64encode(value).decode("ascii")
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)

class _Stream(io.TextIOBase):
    def __init__(self, name):
        self._name = name
    @property
    def encoding(self):
        return "utf-8"
    def writable(self):
        return True
    def isatty(self):
        return False
    def write(self, text):
        if not text:
            return 0
        last = _outputs[-1] if _outputs else None
        if last and last["output_type"] == "stream" and last["name"] == self._name:
            last["text"] += text
        else:
            _outputs.append({"output_type": "stream", "name": self._name, "text": text})
        return len(text)

class _DisplayHook(DisplayHook):
    def start_displayhook(self):
        pass
    def write_output_prompt(self):
        pass
    def write_format_data(self, format_dict, md_dict=None):
        _outputs.append({"output_type": "execute_result", "execution_count": self.prompt_count,
                         "data": _clean(format_dict), "metadata": _clean(md_dict or {})})
    def finish_displayhook(self):
        pass

class _DisplayPublisher(DisplayPublisher):
    def publish(self, data, metadata=None, source=None, *, transient=None, update=False, **kwargs):
        _outputs.append({"output_type": "display_data", "data": _clean(data), "metadata": _clean(metadata or {})})
    def clear_output(self, wait=False):
        pass

_config = Config()
_config.HistoryManager.enabled = False
_shell = InteractiveShell.instance(config=_config, displayhook_class=_DisplayHook,
                                   display_pub_class=_DisplayPublisher)

def _showtraceback(etype, evalue, stb):
    _outputs.append({"output_type": "error", "ename": str(etype.__name__),
                     "evalue": str(evalue), "traceback": stb})
_shell._showtraceback = _showtraceback

def _run(code, execution_count, store_history=True):
    _outputs.clear()
    _shell.execution_count = execution_count
    saved = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = _Stream("stdout"), _Stream("stderr")
    try:
        result = _shell.run_cell(code, store_history=store_history)
    finally:
        sys.stdout, sys.stderr = saved
    failed = result.error_before_exec is not None or result.error_in_exec is not None
    return json.dumps({"outputs": _outputs, "failed": failed})

def _inline(expressions):
    saved = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = _Stream("stdout"), _Stream("stderr")
    try:
        results = _shell.user_expressions(dict(enumerate(expressions)))
    finally:
        sys.stdout, sys.stderr = saved
    return json.dumps([_clean(results[i]) for i in range(len(expressions))])

def _missing_modules(code):
    from importlib.util import find_spec
    from pyodide.code import find_imports
    try:
        names = find_imports(code)
    except SyntaxError:
        return []
    missing = []
    for name in names:
        try:
            if find_spec(name) is None:
                missing.append(name)
        except Exception:
            missing.append(name)
    return missing
`

let pyodide

async function init({ pyodideUrl }) {
  const { loadPyodide } = await import(pyodideUrl)
  pyodide = await loadPyodide({ stdout: () => {}, stderr: () => {} })
  await pyodide.loadPackage(["ipython"], { messageCallback: () => {} })
  pyodide.runPython(KERNEL)
}

// Loads the Pyodide packages the cells import, then tries PyPI (micropip)
// for anything still missing. Each cell is scanned on its own, so one cell
// with a syntax error doesn't hide the others' imports; IPython magics
// (`%matplotlib inline`, `!pip install`) are skipped. Returns the packages
// that were installed.
async function loadPackages({ cells }) {
  const loaded = new Set(Object.keys(pyodide.loadedPackages))
  const sources = cells.map(code => code.split("\n").filter(line => !/^\s*[%!]/.test(line)).join("\n"))
  for (const code of sources) {
    await pyodide.loadPackagesFromImports(code, { messageCallback: () => {} })
  }
  if (pyodide.loadedPackages.matplotlib && !pyodide.loadedPackages["matplotlib-inline"]) {
    await pyodide.loadPackage(["matplotlib-inline"], { messageCallback: () => {} })
  }
  const missing = [...new Set(sources.flatMap(code => pyodide.globals.get("_missing_modules")(code).toJs()))]
  if (missing.length) {
    await pyodide.loadPackage(["micropip"], { messageCallback: () => {} })
    const micropip = pyodide.pyimport("micropip")
    for (const name of missing) {
      try {
        await micropip.install(name)
      } catch {
        // Left for the cell to report as ModuleNotFoundError.
      }
    }
  }
  return Object.keys(pyodide.loadedPackages).filter(name => !loaded.has(name))
}

function run({ code, executionCount, storeHistory = true }) {
  return JSON.parse(pyodide.globals.get("_run")(code, executionCount, storeHistory))
}

function inline({ expressions }) {
  return JSON.parse(pyodide.globals.get("_inline")(pyodide.toPy(expressions)))
}

const handlers = { init, loadPackages, run, inline }

self.onmessage = async ({ data: { id, type, args } }) => {
  try {
    self.postMessage({ id, result: await handlers[type](args) })
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) })
  }
}
