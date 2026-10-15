import ast
from e1.amech import rewrite_source

MOD = b'''import re

def helper(value, flag=False):
    return value.upper()

def other(x):
    return helper(x) + re.escape(x)
'''

CALLER = b'''from django.utils.text import helper
from django.utils import text as T

class K:
    def escape(self, v):
        return v

def a(v):
    return helper(v,) + T.helper(v) + helper(
        v
    )

def b():
    return K().escape(1)
'''


def rw(src, mech, defining, file_module="django.utils.text"):
    return rewrite_source(src, file_module, False, "django.utils.text", "helper", mech, defining)


def test_signature_adds_required_kwonly_and_updates_calls():
    out = rw(MOD, "signature", True)
    ast.parse(out)
    assert b"def helper(value, flag=False, *, strict):" in out
    assert b"helper(x, strict=False)" in out
    assert b"re.escape(x)" in out  # unrelated attribute untouched


def test_signature_caller_trailing_comma_multiline_and_alias():
    out = rw(CALLER, "signature", False, file_module="myapp.views")
    ast.parse(out)
    assert b"helper(v, strict=False)" in out          # trailing comma handled
    assert b"T.helper(v, strict=False)" in out        # module alias
    assert b"K().escape(1)" in out                    # same-named method untouched
    assert out.count(b"strict=False") == 3


def test_rename_def_imports_and_refs():
    out = rw(CALLER, "rename", False, file_module="myapp.views")
    ast.parse(out)
    assert b"from django.utils.text import helper_v2" in out
    assert b"T.helper_v2(v)" in out
    assert b"helper_v2(v,)" in out
    mod = rw(MOD, "rename", True)
    assert b"def helper_v2(value, flag=False):" in mod and b"return helper_v2(x)" in mod


def test_rettype_wraps_returns_and_unwraps_calls():
    out = rw(MOD, "rettype", True)
    ast.parse(out)
    assert b"class _CoordT:" in out
    assert b"return _CoordT(value.upper())" in out
    assert b"return helper(x).text + re.escape(x)" in out


def test_zero_arg_call_signature():
    src = b"from django.utils.text import helper\nhelper()\n"
    out = rw(src, "signature", False, file_module="m")
    assert b"helper(strict=False)" in out


LAZY = b'''from django.utils.functional import keep_lazy_text

@keep_lazy_text
def helper(x, last=None):
    return x.upper()

def other(x):
    return helper(x) + "!"
'''


def test_rettype_on_lazy_decorated_helper_keeps_laziness():
    # keep_lazy returns a __proxy__ for lazy args, which has no .text: the decorated
    # original must stay intact and the _CoordT wrap must sit outside it.
    out = rw(LAZY, "rettype", True)
    ast.parse(out)
    assert b"@keep_lazy_text\ndef _helper_impl(x, last=None):\n    return x.upper()" in out
    assert b"def helper(x, last=None):\n    return _CoordT(_helper_impl(x, last))" in out
    assert b"return helper(x).text + \"!\"" in out
    ns = {}
    exec(out.replace(b"from django.utils.functional import keep_lazy_text", b"keep_lazy_text = lambda f: f"), ns)
    assert ns["helper"]("a").text == "A" and ns["other"]("a") == "A!"


def test_helper_passed_as_value_is_adapted():
    # tests/utils_tests/test_html.py does check_output(escape, value, output)
    src = b"from django.utils.text import helper\nfrom django.utils import text as T\nrun(helper, 1)\nmap(T.helper, xs)\n"
    sig = rw(src, "signature", False, file_module="m")
    assert b"run((lambda *a, **k: helper(*a, strict=False, **k)), 1)" in sig
    assert b"map((lambda *a, **k: T.helper(*a, strict=False, **k)), xs)" in sig
    ret = rw(src, "rettype", False, file_module="m")
    assert b"run((lambda *a, **k: helper(*a, **k).text), 1)" in ret
    assert b"import helper\n" in sig and b"import helper\n" in ret  # import line untouched
