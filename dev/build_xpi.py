#!/usr/bin/env python3
"""Build the MailExtension into dist/dsh-thunderbird-bridge-<version>.xpi.

Why Python instead of PowerShell's ZipFile::CreateFromDirectory: on .NET
Framework that API writes entry names with backslash separators, nsIZipReader
takes them literally, and Thunderbird then fails the install with
ERROR_CORRUPT_FILE. zipfile always writes forward slashes.
"""

from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

SKIP = {".DS_Store", "Thumbs.db"}


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    src = repo / "thunderbird-addon"
    dist = repo / "dist"

    if not (src / "manifest.json").is_file():
        print(f"no manifest.json under {src}", file=sys.stderr)
        return 1

    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    gecko = manifest.get("browser_specific_settings") or manifest["applications"]
    addon_id = gecko["gecko"]["id"]

    dist.mkdir(parents=True, exist_ok=True)
    out = dist / f"dsh-thunderbird-bridge-{version}.xpi"
    if out.exists():
        out.unlink()

    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(src.rglob("*")):
            if not path.is_file() or path.name in SKIP:
                continue
            # as_posix() keeps the separators forward-slash on every platform
            zf.write(path, path.relative_to(src).as_posix())

    names = zipfile.ZipFile(out).namelist()
    print(f"built  {out}  ({out.stat().st_size / 1024:.1f} KB)")
    print(f"id     {addon_id}")
    for name in names:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
