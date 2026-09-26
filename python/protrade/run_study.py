"""Runs a Study Specification: ``python -m protrade.run_study spec.json``.

This is what the app's Studies tab starts when Run Study is pressed. It is a module of its own,
not part of ``protrade.study``, because running a module the package has already imported (as
``-m protrade.study`` would) makes Python load it twice.
"""

from __future__ import annotations

import json
import sys

from . import client
from .study import SpecError, StudyDataError, run_spec


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m protrade.run_study spec.json", file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, ValueError) as e:
        print(f"Couldn't read the Study Specification: {e}", file=sys.stderr)
        return 2
    try:
        run_spec(spec)
    except (SpecError, StudyDataError, client.ProTradeError) as e:
        # A problem the user can act on: said plainly, without a traceback.
        print(f"Study stopped: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
