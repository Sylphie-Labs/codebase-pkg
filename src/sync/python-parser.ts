/**
 * python-parser.ts -- Python AST extraction via the user's Python runtime.
 *
 * Spawns `python3` (or `python`) with an embedded stdlib-only script that
 * uses the `ast` module to extract functions, classes, and imports from .py
 * files, emitting the exact same ParsedFile shape as ast-parser.ts so the
 * rest of the pipeline (graph-differ, mutation-builder, initial-seed) is
 * language-agnostic.
 *
 * Zero new npm dependencies: the script ships embedded in this module (and
 * therefore inside dist/ automatically). File lists are passed via STDIN to
 * avoid Windows command-line length limits; results come back as one JSON
 * document on stdout. Per-file parse errors are reported on stderr and the
 * file is skipped — they never crash the batch.
 */

import { spawnSync } from 'child_process';
import type { ParsedFile } from './ast-parser.js';

// ---------------------------------------------------------------------------
// Embedded Python script (stdlib only: sys, json, ast, hashlib, os)
// ---------------------------------------------------------------------------

const EMBEDDED_SCRIPT = String.raw`
import sys, json, ast, hashlib, os

PY_BUILTINS = set('print len range isinstance issubclass super str int float bool list dict set tuple enumerate zip map filter sorted getattr setattr hasattr open type repr format vars iter next min max sum abs round any all'.split())

TYPING_BUILTINS = set('List Dict Set Tuple Optional Union Any Callable Iterable Iterator Sequence Mapping Type Literal Annotated ClassVar Final Self None True False'.split())

HTTP_VERBS = set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options'])


def dotted(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = dotted(node.value)
        if base is None:
            return None
        return base + '.' + node.attr
    return None


def strip_quotes(s):
    if len(s) >= 2 and s[0] in ('"', "'") and s[-1] == s[0]:
        return s[1:-1]
    return s


def unparse(node):
    try:
        return ast.unparse(node)
    except Exception:
        return 'unknown'


def decorator_entry(dec):
    if isinstance(dec, ast.Call):
        name = dotted(dec.func) or unparse(dec.func)
        args = [strip_quotes(unparse(a)) for a in dec.args]
        return {'name': name, 'args': args}
    name = dotted(dec) or unparse(dec)
    return {'name': name, 'args': []}


def endpoint_info(decorator_nodes):
    # FastAPI/Flask styles:
    #   @x.get('/path')                    -> ('GET', '/path')
    #   @x.route('/path', methods=['POST']) -> ('POST', '/path')
    for dec in decorator_nodes:
        if not isinstance(dec, ast.Call):
            continue
        func = dec.func
        if isinstance(func, ast.Attribute):
            attr = func.attr
        elif isinstance(func, ast.Name):
            attr = func.id
        else:
            continue
        attr_l = attr.lower()
        first_arg = None
        if dec.args:
            a0 = dec.args[0]
            if isinstance(a0, ast.Constant) and isinstance(a0.value, str):
                first_arg = a0.value
        if first_arg is None:
            continue
        if attr_l in HTTP_VERBS:
            return attr_l.upper(), first_arg
        if attr_l == 'route':
            method = 'GET'
            for kw in dec.keywords:
                if kw.arg == 'methods' and isinstance(kw.value, (ast.List, ast.Tuple)) and kw.value.elts:
                    e0 = kw.value.elts[0]
                    if isinstance(e0, ast.Constant) and isinstance(e0.value, str):
                        method = e0.value.upper()
            return method, first_arg
    return None, None


def collect_callees(fn_node):
    out = []
    seen = set()
    for stmt in fn_node.body:
        for child in ast.walk(stmt):
            if not isinstance(child, ast.Call):
                continue
            name = dotted(child.func)
            if not name:
                continue
            if name.startswith('self.'):
                name = name[5:]
            if not name or len(name) > 80:
                continue
            if name in PY_BUILTINS:
                continue
            if name not in seen:
                seen.add(name)
                out.append(name)
    return out


def annotation_names(ann):
    names = []
    if ann is None:
        return names
    for child in ast.walk(ann):
        if isinstance(child, ast.Name):
            n = child.id
        elif isinstance(child, ast.Attribute):
            n = child.attr
        else:
            continue
        if n and n[0].isupper() and n not in TYPING_BUILTINS:
            names.append(n)
    return names


def all_plain_args(fn_node):
    a = fn_node.args
    return list(a.posonlyargs) + list(a.args) + list(a.kwonlyargs)


def extract_args(fn_node):
    args = []
    for arg in all_plain_args(fn_node):
        if arg.arg in ('self', 'cls'):
            continue
        ann = unparse(arg.annotation) if arg.annotation is not None else 'unknown'
        args.append({'name': arg.arg, 'type': ann})
    return args


def function_entry(fn_node, file_path, source, qualname, bare_name):
    seg = ast.get_source_segment(source, fn_node) or ''
    args = extract_args(fn_node)
    ret = unparse(fn_node.returns) if fn_node.returns is not None else 'unknown'
    decorators = [decorator_entry(d) for d in fn_node.decorator_list]
    http_method, route_path = endpoint_info(fn_node.decorator_list)
    type_refs = set()
    for arg in all_plain_args(fn_node):
        if arg.arg in ('self', 'cls'):
            continue
        for n in annotation_names(arg.annotation):
            type_refs.add(n)
    for n in annotation_names(fn_node.returns):
        type_refs.add(n)
    entry = {
        'name': qualname,
        'filePath': file_path,
        'lineNumber': fn_node.lineno,
        'endLine': fn_node.end_lineno or fn_node.lineno,
        'args': args,
        'returnType': ret,
        'jsDoc': ast.get_docstring(fn_node) or '',
        'bodyText': seg[:8000],
        'isExported': not bare_name.startswith('_'),
        'isAsync': isinstance(fn_node, ast.AsyncFunctionDef),
        'decorators': decorators,
        'callees': collect_callees(fn_node),
        'typeRefs': sorted(type_refs),
        'contentHash': hashlib.sha256(seg.encode('utf-8')).hexdigest()[:16],
    }
    if http_method is not None:
        entry['httpMethod'] = http_method
        entry['routePath'] = route_path
    return entry


def class_entry(cls_node, file_path, source):
    seg = ast.get_source_segment(source, cls_node) or ''
    properties = []
    for stmt in cls_node.body:
        if isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name):
            ann = unparse(stmt.annotation) if stmt.annotation is not None else 'unknown'
            properties.append({'name': stmt.target.id, 'type': ann})
        elif isinstance(stmt, ast.Assign):
            for tgt in stmt.targets:
                if isinstance(tgt, ast.Name):
                    properties.append({'name': tgt.id, 'type': 'unknown'})
    bases = []
    for b in cls_node.bases:
        bases.append(dotted(b) or unparse(b))
    ctor_params = []
    for stmt in cls_node.body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)) and stmt.name == '__init__':
            for arg in all_plain_args(stmt):
                if arg.arg in ('self', 'cls'):
                    continue
                ann = unparse(arg.annotation) if arg.annotation is not None else 'unknown'
                ctor_params.append({'name': arg.arg, 'type': ann})
            break
    entry = {
        'name': cls_node.name,
        'filePath': file_path,
        'lineNumber': cls_node.lineno,
        'kind': 'class',
        'properties': properties,
        'bodyText': seg[:8000],
        'comment': ast.get_docstring(cls_node) or '',
        'decorators': [decorator_entry(d) for d in cls_node.decorator_list],
        'implements': bases[1:],
        'constructorParams': ctor_params,
        'contentHash': hashlib.sha256(seg.encode('utf-8')).hexdigest()[:16],
    }
    if bases:
        entry['extends'] = bases[0]
    return entry


def collect_imports(tree, file_path):
    out = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.append({
                    'fromFile': file_path,
                    'moduleSpecifier': alias.name,
                    'importedNames': [alias.asname or alias.name],
                })
        elif isinstance(node, ast.ImportFrom):
            spec = '.' * node.level + (node.module or '')
            out.append({
                'fromFile': file_path,
                'moduleSpecifier': spec,
                'importedNames': [a.name for a in node.names],
            })
    return out


def parse_file(file_path):
    # utf-8-sig transparently strips a BOM if present (common on Windows)
    with open(file_path, 'r', encoding='utf-8-sig', errors='replace') as fh:
        source = fh.read()
    tree = ast.parse(source, filename=file_path)
    functions = []
    types = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            functions.append(function_entry(node, file_path, source, node.name, node.name))
        elif isinstance(node, ast.ClassDef):
            types.append(class_entry(node, file_path, source))
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    qual = node.name + '.' + sub.name
                    functions.append(function_entry(sub, file_path, source, qual, sub.name))
    if source:
        line_count = source.count('\n') + (0 if source.endswith('\n') else 1)
    else:
        line_count = 0
    return {
        'filePath': file_path,
        'fileName': os.path.basename(file_path),
        'extension': '.py',
        'lineCount': line_count,
        'functions': functions,
        'types': types,
        'imports': collect_imports(tree, file_path),
    }


def main():
    raw = sys.stdin.read()
    try:
        paths = json.loads(raw)
    except Exception as exc:
        sys.stderr.write('[python-parser] WARNING: invalid input JSON - ' + str(exc) + '\n')
        sys.stdout.write('[]')
        return
    results = []
    for p in paths:
        fp = str(p).replace('\\', '/')
        try:
            results.append(parse_file(fp))
        except Exception as exc:
            sys.stderr.write('[python-parser] WARNING: skipping ' + fp + ' - ' + str(exc) + '\n')
    sys.stdout.write(json.dumps(results))


main()
`;

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/** Cached result of the runtime probe: undefined = not probed yet. */
let _pythonBin: string | null | undefined;

/**
 * Find a working Python runtime on PATH. Probes `python3` first, then
 * `python` (Windows installs typically only have `python`). Result is
 * cached for the process lifetime. Returns the binary name or null.
 */
export function detectPythonBinary(): string | null {
  if (_pythonBin !== undefined) return _pythonBin;

  for (const bin of ['python3', 'python']) {
    try {
      const res = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
      // Windows Store aliases exit non-zero with a "not found" message;
      // a real runtime exits 0 and prints "Python 3.x.y".
      if (!res.error && res.status === 0) {
        _pythonBin = bin;
        return bin;
      }
    } catch {
      // probe failure — try the next candidate
    }
  }

  _pythonBin = null;
  return null;
}

/** Whether a usable python3/python runtime exists on PATH. */
export function pythonAvailable(): boolean {
  return detectPythonBinary() !== null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse Python files into the shared ParsedFile shape.
 *
 * Per-file parse errors are reported on stderr by the embedded script and
 * the file is skipped. If no Python runtime exists, all files are skipped
 * with a single warning.
 */
export function parsePythonFiles(filePaths: string[]): ParsedFile[] {
  if (filePaths.length === 0) return [];

  const bin = detectPythonBinary();
  if (!bin) {
    process.stderr.write(
      `[python-parser] WARNING: ${filePaths.length} .py file(s) skipped — no python3/python runtime found on PATH\n`
    );
    return [];
  }

  const normalised = filePaths.map(p => p.replace(/\\/g, '/'));

  const result = spawnSync(bin, ['-c', EMBEDDED_SCRIPT], {
    input: JSON.stringify(normalised),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });

  // Forward per-file warnings emitted by the script.
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error || result.status !== 0) {
    const msg = result.error ? result.error.message : `exit code ${result.status}`;
    process.stderr.write(`[python-parser] WARNING: python parse batch failed — ${msg}\n`);
    return [];
  }

  try {
    return JSON.parse(result.stdout) as ParsedFile[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[python-parser] WARNING: invalid JSON from python parser — ${msg}\n`);
    return [];
  }
}
