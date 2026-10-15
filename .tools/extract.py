"""Write the plan's fenced code block whose first line names <relpath> into ~/Documents/loom/<relpath>."""
import re, sys, pathlib
plan = pathlib.Path.home() / "Documents/Brain/10-Projects/graph-hacks-falkordb/plans/01-thesis-gate.md"
root = pathlib.Path.home() / "Documents/loom"
text = plan.read_text()
blocks = re.findall(r"```[a-z]*\n(.*?)```", text, re.S)
for rel in sys.argv[1:]:
    hits = [b for b in blocks if b.split("\n", 1)[0].strip() in (f"# {rel}", f"// {rel}")]
    assert len(hits) == 1, (rel, len(hits))
    body = hits[0].split("\n", 1)[1] if hits[0].startswith("//") or rel.endswith(".py") else hits[0]
    p = root / rel; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(body)
    print("wrote", rel, len(body.splitlines()), "lines")
