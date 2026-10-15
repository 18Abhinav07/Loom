"""Detached A-trigger for the interactive demo: python -m e1.live_trigger <instance-id> <run> <wt_a>"""
import sys
from pathlib import Path
from .instances import load_instances
from .live import LiveRun

inst = {i.id: i for i in load_instances()}[sys.argv[1]]
lr = LiveRun(inst, "demo", Path("."), Path("."), a_at="edit")
lr.run, lr.wt_a = sys.argv[2], Path(sys.argv[3])
lr._trigger()
