#!/usr/bin/env python3
"""Evaluate JavaScript inside a running Thunderbird through Marionette.

This is the ground-truth channel for anything the panel cannot see: real
AddonManager state, WebExtension policies, prefs, and whether a background page
is actually alive.

Start Thunderbird with Marionette first:

    thunderbird.exe -marionette -remote-allow-system-access

Then:

    python dev/marionette-eval.py --expr "Services.prefs.getBoolPref('xpinstall.signatures.required')"
    python dev/marionette-eval.py --file scratch.js --sandbox system --async

The script receives any --arg values as arguments[0..n]; with --async the last
argument is the completion callback. `chrome` context is selected before the
script runs, because AddonManager and friends only exist in the parent process.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from importlib import import_module
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
mod = import_module("install-extension")
Marionette = mod.Marionette
MarionetteError = mod.MarionetteError


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=mod.DEFAULT_PORT)
    parser.add_argument("--expr", default=None, help="inline JavaScript expression")
    parser.add_argument("--file", default=None, help="path to a .js file")
    parser.add_argument("--arg", action="append", default=[], help="script argument")
    parser.add_argument("--async", dest="is_async", action="store_true",
                        help="use ExecuteAsyncScript (callback is appended)")
    parser.add_argument("--sandbox", default="system",
                        choices=["default", "system"])
    args = parser.parse_args()

    if (args.expr is None) == (args.file is None):
        raise SystemExit("pass exactly one of --expr / --file")
    # Marionette evaluates the script as a function body and reports its
    # completion value, so an inline expression needs an explicit return.
    script = f"return ({args.expr});" if args.expr is not None else Path(args.file).read_text(encoding="utf-8")

    client = Marionette(args.port)
    try:
        for attempt in range(15):
            try:
                client.send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})
                break
            except MarionetteError:
                if attempt == 14:
                    raise
                time.sleep(2)
        client.send("Marionette:SetContext", {"value": "chrome"})

        params = {
            "script": script,
            "args": args.arg,
            "sandbox": args.sandbox,
            "newSandbox": True,
        }
        command = "WebDriver:ExecuteScript"
        if args.is_async:
            command = "WebDriver:ExecuteAsyncScript"
            params["scriptTimeout"] = 120000
        result = client.send(command, params)
        value = result.get("value") if isinstance(result, dict) else result
        if isinstance(value, str):
            try:
                print(json.dumps(json.loads(value), indent=2, ensure_ascii=False))
                return 0
            except json.JSONDecodeError:
                pass
        print(json.dumps(value, indent=2, ensure_ascii=False, default=str))
        return 0
    finally:
        try:
            client.send("WebDriver:DeleteSession", {})
        except Exception:
            pass
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
