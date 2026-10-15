"""Deterministic 'agent A' for the STALE real-derived tier.

Each mechanism makes a breaking, behaviour-preserving change to one helper and
updates every in-repo caller it can resolve, as in the paper's construction.
Edits are byte-precise using ast positions (col offsets are UTF-8 bytes).
"""
from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path

from .instances import Instance

RENAME_SUFFIX = "_v2"
WRAPPER = (
    b"class _CoordT:\n"
    b'    """Return wrapper introduced by a concurrent change (rettype)."""\n\n'
    b'    __slots__ = ("text",)\n\n'
    b"    def __init__(self, text):\n"
    b"        self.text = text\n\n\n"
)


@dataclass(frozen=True)
class Edit:
    start: int
    end: int
    text: bytes


def apply_edits(src: bytes, edits: list[Edit]) -> bytes:
    for e in sorted(edits, key=lambda e: (e.start, e.end), reverse=True):
        src = src[: e.start] + e.text + src[e.end :]
    return src


class Pos:
    def __init__(self, src: bytes):
        self.starts = [0] + [i + 1 for i, b in enumerate(src) if b == 0x0A]

    def __call__(self, lineno: int, col: int) -> int:
        return self.starts[lineno - 1] + col

    def start(self, node: ast.AST) -> int:
        return self(node.lineno, node.col_offset)

    def end(self, node: ast.AST) -> int:
        return self(node.end_lineno, node.end_col_offset)


def _abs_module(file_module: str, is_pkg: bool, node: ast.ImportFrom) -> str | None:
    if node.level == 0:
        return node.module
    parts = file_module.split(".")
    base = parts if is_pkg else parts[:-1]
    base = base[: len(base) - (node.level - 1)] if node.level > 1 else base
    return ".".join(base + ([node.module] if node.module else []))


def _bindings(tree: ast.Module, file_module: str, is_pkg: bool, target: str, func: str, defining: bool):
    direct: set[str] = {func} if defining else set()
    mods: set[str] = set()
    aliases: list[ast.alias] = []
    pkg, _, leaf = target.rpartition(".")
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            mod = _abs_module(file_module, is_pkg, node)
            for a in node.names:
                if mod == target and a.name == func:
                    direct.add(a.asname or a.name)
                    aliases.append(a)
                if mod == pkg and a.name == leaf:
                    mods.add(a.asname or a.name)
        elif isinstance(node, ast.Import):
            for a in node.names:
                if a.name == target and a.asname:
                    mods.add(a.asname)
    return direct, mods, aliases


def _is_ref(node: ast.AST, direct: set[str], mods: set[str], func: str) -> bool:
    if isinstance(node, ast.Name):
        return node.id in direct
    return (isinstance(node, ast.Attribute) and node.attr == func
            and isinstance(node.value, ast.Name) and node.value.id in mods)


def _call_insert_kw(src: bytes, pos: Pos, call: ast.Call, text: bytes) -> Edit:
    close = pos.end(call) - 1  # index of ')'
    i = close - 1
    while i >= 0 and src[i : i + 1] in (b" ", b"\n", b"\t", b"\r"):
        i -= 1
    empty = not call.args and not call.keywords
    sep = b"" if empty else (b" " if src[i : i + 1] == b"," else b", ")
    return Edit(i + 1, i + 1, sep + text) if not empty else Edit(close, close, text)


def _top_def(tree: ast.Module, func: str) -> ast.FunctionDef:
    for n in tree.body:
        if isinstance(n, ast.FunctionDef) and n.name == func:
            return n
    raise ValueError(f"no top-level def {func}")


def _is_lazy(fn: ast.FunctionDef) -> bool:
    return any("keep_lazy" in ast.unparse(d) for d in fn.decorator_list)


def rewrite_source(src: bytes, file_module: str, is_pkg: bool, target_module: str,
                   func: str, mech: str, defining: bool) -> bytes:
    tree = ast.parse(src)
    pos = Pos(src)
    direct, mods, aliases = _bindings(tree, file_module, is_pkg, target_module, func, defining)
    edits: list[Edit] = []
    calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and _is_ref(n.func, direct, mods, func)]
    fn = _top_def(tree, func) if defining else None
    callees = {id(c.func) for c in calls}
    values = [n for n in ast.walk(tree) if _is_ref(n, direct, mods, func)
              and isinstance(n.ctx, ast.Load) and id(n) not in callees]  # helper passed as a value

    def adapt(template: bytes) -> list[Edit]:
        return [Edit(pos.start(n), pos.end(n), template.replace(b"@@", src[pos.start(n):pos.end(n)])) for n in values]

    if mech == "signature":
        edits += adapt(b"(lambda *a, **k: @@(*a, strict=False, **k))")
        if fn is not None:
            a = fn.args
            assert not (a.vararg or a.kwonlyargs or a.kwarg), "helper with */**: extend amech"
            params = a.posonlyargs + a.args
            last = a.defaults[-1] if a.defaults else params[-1]
            edits.append(Edit(pos.end(last), pos.end(last), b", *, strict"))
        edits += [_call_insert_kw(src, pos, c, b"strict=False") for c in calls]

    elif mech == "rename":
        new = (func + RENAME_SUFFIX).encode()
        if fn is not None:
            at = src.index(b"def " + func.encode(), pos(fn.lineno, 0)) + 4
            edits.append(Edit(at, at + len(func), new))
            for n in ast.walk(tree):  # __all__ entries
                if (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__all__" for t in n.targets)):
                    for c in ast.walk(n.value):
                        if isinstance(c, ast.Constant) and c.value == func:
                            edits.append(Edit(pos.start(c), pos.end(c), b'"' + new + b'"'))
        for a in aliases:
            s = pos(a.lineno, a.col_offset)
            edits.append(Edit(s, s + len(func), new))
        for n in ast.walk(tree):
            if isinstance(n, ast.Name) and n.id == func and func in direct:
                edits.append(Edit(pos.start(n), pos.end(n), new))
            elif _is_ref(n, set(), mods, func):
                e = pos.end(n)
                edits.append(Edit(e - len(func), e, new))

    elif mech == "rettype":
        edits += adapt(b"(lambda *a, **k: @@(*a, **k).text)")
        if fn is not None and _is_lazy(fn):
            # keep_lazy returns a __proxy__ for lazy args, which has no .text: keep the
            # decorated original as _<func>_impl and wrap outside it.
            first = fn.decorator_list[0].lineno
            edits.append(Edit(pos(first, 0), pos(first, 0), WRAPPER))
            at = src.index(b"def " + func.encode(), pos(fn.lineno, 0)) + 4
            edits.append(Edit(at, at + len(func), f"_{func}_impl".encode()))
            a = fn.args
            fwd = [p.arg for p in a.posonlyargs + a.args]
            fwd += [f"*{a.vararg.arg}"] if a.vararg else []
            fwd += [f"{k.arg}={k.arg}" for k in a.kwonlyargs]
            fwd += [f"**{a.kwarg.arg}"] if a.kwarg else []
            outer = (f"\n\ndef {func}({ast.unparse(a)}):\n"
                     f"    return _CoordT(_{func}_impl({', '.join(fwd)}))\n").encode()
            edits.append(Edit(pos.end(fn), pos.end(fn), outer))
        elif fn is not None:
            first = fn.decorator_list[0].lineno if fn.decorator_list else fn.lineno
            edits.append(Edit(pos(first, 0), pos(first, 0), WRAPPER))
            stack = list(fn.body)
            while stack:
                n = stack.pop()
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
                    continue
                if isinstance(n, ast.Return) and n.value is not None:
                    s, e = pos.start(n.value), pos.end(n.value)
                    edits.append(Edit(s, e, b"_CoordT(" + src[s:e] + b")"))
                stack.extend(ast.iter_child_nodes(n))
        for c in calls:
            e = pos.end(c)
            edits.append(Edit(e, e, b".text"))
    else:
        raise ValueError(mech)

    out = apply_edits(src, edits)
    ast.parse(out)  # every rewrite must stay valid Python
    return out


def _file_module(rel: str) -> tuple[str, bool]:
    p = rel[:-3].replace("/", ".")
    return (p[: -len(".__init__")], True) if p.endswith(".__init__") else (p, False)


def apply_mechanism(root: Path, inst: Instance) -> list[str]:
    changed: list[str] = []
    for top in ("django", "tests"):
        for path in (root / top).rglob("*.py"):
            rel = path.relative_to(root).as_posix()
            data = path.read_bytes()
            if inst.func.encode() not in data:
                continue
            fm, is_pkg = _file_module(rel)
            try:
                out = rewrite_source(data, fm, is_pkg, inst.module, inst.func, inst.mechanism,
                                     defining=(rel == inst.module_path))
            except SyntaxError:
                continue  # deliberately invalid fixture files in tests/
            if out != data:
                path.write_bytes(out)
                changed.append(rel)
    return changed


def describe_change(inst: Instance, root: Path) -> str:
    """Oracle text: a complete description of A's finished change (the paper's comm message)."""
    tree = ast.parse((root / inst.module_path).read_bytes())
    params = ast.unparse(_top_def(tree, inst.func).args)
    f, m = inst.func, inst.module
    if inst.mechanism == "signature":
        return (f"`{m}.{f}` gains a new REQUIRED keyword-only parameter `strict`: new signature "
                f"`{f}({params}, *, strict)`. Behaviour is unchanged; existing callers now pass `strict=False`. "
                f"A call without `strict=` raises TypeError.")
    if inst.mechanism == "rename":
        return (f"`{m}.{f}` is renamed to `{f}{RENAME_SUFFIX}` with identical behaviour and signature "
                f"`({params})`. The old name `{f}` no longer exists.")
    return (f"`{m}.{f}({params})` now returns a `_CoordT` wrapper instead of the plain value; the original "
            f"result is in its `.text` attribute. Existing callers now use `{f}(...).text`.")
