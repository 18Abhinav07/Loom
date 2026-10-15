"""STALE-bench real-derived tier (36 instances), joined to their anchor base commits."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

STALE_DIR = Path(os.environ.get("STALE_BENCH", Path(__file__).resolve().parents[2] / "third_party" / "STALE-bench"))

MODULE_TEST = {
    "django/utils/text.py": "utils_tests.test_text",
    "django/utils/html.py": "utils_tests.test_html",
    "django/utils/http.py": "utils_tests.test_http",
    "django/utils/encoding.py": "utils_tests.test_encoding",
}

PILOT = [f"{f}__signature" for f in (
    "phone2numeric", "slugify", "get_valid_filename", "normalize_newlines", "int_to_base36", "base36_to_int",
)]

# Held-out core set: each of the 12 helpers exactly once, 4 per mechanism, no overlap with PILOT
# (so the core result is on instances notice wording was never tuned on).
CORE = [
    "capfirst__signature", "escape__signature", "get_text_list__signature", "iri_to_uri__signature",
    "strip_tags__rename", "urlencode__rename", "phone2numeric__rename", "slugify__rename",
    "get_valid_filename__rettype", "normalize_newlines__rettype", "int_to_base36__rettype", "base36_to_int__rettype",
]


@dataclass(frozen=True)
class Instance:
    id: str
    symbol: str
    func: str
    module: str
    module_path: str
    mechanism: str  # rename | signature | rettype
    task_b: str
    oracle_test: str
    base_commit: str
    module_test: str


def load_instances(stale_dir: Path = STALE_DIR) -> list[Instance]:
    with open(stale_dir / "instances" / "django.jsonl") as f:
        pairs = {p["id"]: p for p in map(json.loads, f)}
    out: list[Instance] = []
    with open(stale_dir / "results" / "realstale_batch.jsonl") as f:
        for line in f:
            x = json.loads(line)
            module, func = x["symbol"].rsplit(".", 1)
            path = module.replace(".", "/") + ".py"
            out.append(Instance(
                id=x["id"], symbol=x["symbol"], func=func, module=module, module_path=path,
                mechanism=x["mechanism"], task_b=x["task_B"], oracle_test=x["oracle_test"],
                base_commit=pairs[x["anchored_to_pair"]]["base_commit"], module_test=MODULE_TEST[path],
            ))
    return out
