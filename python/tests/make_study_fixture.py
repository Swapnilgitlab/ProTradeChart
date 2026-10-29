"""Regenerates src/studies/fixtures/engine-result.json, the engine output the app's tests parse.

Run it (``python python/tests/make_study_fixture.py``) whenever the Study result changes shape;
``test_study.py`` fails until you do.
"""

import io
import json
import os
from contextlib import redirect_stderr, redirect_stdout

import test_study as t  # also puts the package on the path

from protrade import study

data = {"india:NSE:WIN": t.features_of(t.doubler()), "india:NSE:FLAT": t.features_of(t.wobble(3))}
s = study.ResearchStudy(t.spec(), progress=False)
s.names = {"india:NSE:WIN": "Winner Ltd"}
events = s.detect_events(data)
measured = s.measure(events, data)
control = s.measure(s.control_group(data, events), data)
with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
    result = s.analyze(measured, control, data, show=False)
# Pinned, so regenerating changes the file only when the shape or the numbers do.
result["meta"].update(executed_at="2026-09-26T09:50:00+00:00", elapsed_seconds=1.0, app_version="0.1.0", engine_build="fixture0")
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "studies", "fixtures", "engine-result.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=1)
    f.write("\n")
print(f"wrote {os.path.normpath(path)}")
