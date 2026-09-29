"""Runs a screen: ``python -m protrade.run_screen screen.json``.

This is what the app's Screener tab starts when Run is pressed. A module of its own for the same
reason as ``run_study``: ``-m protrade.screen`` would load a module the package already imported.
"""

from __future__ import annotations

import json
import sys

from . import client
from .screen import ENGINE_VERSION, ScreenError, engine_build, run_screen


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python -m protrade.run_screen screen.json", file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as f:
            spec = json.load(f)
    except (OSError, ValueError) as e:
        print(f"Couldn't read the screen: {e}", file=sys.stderr)
        return 2
    print(f"[engine] protrade screen {ENGINE_VERSION} ({engine_build()})", flush=True)
    try:
        run_screen(spec)
    except (ScreenError, client.ProTradeError) as e:
        # A problem the user can act on: said plainly, without a traceback.
        print(f"Screen stopped: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
