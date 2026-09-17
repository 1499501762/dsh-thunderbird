#!/usr/bin/env python3
"""Ask a live Thunderbird which manifests its AddonManager will accept.

getInstallForFile() reports -3 (ERROR_CORRUPT_FILE) for our real add-on even
though nsIZipReader lists every entry, so the archive is fine and something in
the manifest is not. This probes minimal manifests to separate the variables:

    python dev/probe-manifest.py            # Thunderbird must already be
                                            # running with -marionette
"""

from __future__ import annotations

import json
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib import import_module  # noqa: E402

mod = import_module("install-extension")
Marionette = mod.Marionette
MarionetteError = mod.MarionetteError
DEFAULT_PORT = mod.DEFAULT_PORT

PROBE_SCRIPT = r"""
const path = arguments[0];
const cb = arguments[arguments.length - 1];
(async () => {
  const out = {};
  try {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    const install = await AddonManager.getInstallForFile(file);
    out.state = install.state;
    out.error = install.error;
    if (!install.error) {
      await install.install();
      const addon = install.addon;
      out.installed = true;
      out.id = addon ? addon.id : null;
      out.isActive = addon ? addon.isActive : null;
      if (addon) { await addon.uninstall(); out.uninstalled = true; }
    }
  } catch (e) {
    out.exception = String((e && (e.message || e)) || e);
  }
  cb(JSON.stringify(out));
})();
"""

VARIANTS = {
    "mv2-minimal": {
        "manifest_version": 2,
        "name": "probe mv2",
        "version": "1.0",
        "browser_specific_settings": {"gecko": {"id": "probe-mv2@dsh.local"}},
        "background": {"scripts": ["bg.js"]},
        "permissions": ["storage"],
    },
    "mv3-minimal": {
        "manifest_version": 3,
        "name": "probe mv3",
        "version": "1.0",
        "browser_specific_settings": {"gecko": {"id": "probe-mv3@dsh.local"}},
        "background": {"scripts": ["bg.js"]},
        "permissions": ["storage"],
    },
    "mv2-browseraction": {
        "manifest_version": 2,
        "name": "probe mv2 action",
        "version": "1.0",
        "browser_specific_settings": {"gecko": {"id": "probe-mv2-action@dsh.local"}},
        "background": {"scripts": ["bg.js"], "persistent": True},
        "browser_action": {"default_title": "probe", "default_area": "tabstrip"},
        "permissions": ["storage"],
    },
    "mv2-msgperm": {
        "manifest_version": 2,
        "name": "probe mv2 mail",
        "version": "1.0",
        "browser_specific_settings": {"gecko": {"id": "probe-mv2-mail@dsh.local"}},
        "background": {"scripts": ["bg.js"]},
        "permissions": ["messagesRead", "accountsRead", "http://127.0.0.1/*"],
    },
}


def build(name: str, manifest: dict, directory: Path) -> Path:
    path = directory / f"{name}.xpi"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))
        zf.writestr("bg.js", "'use strict'\n")
    return path


def main() -> int:
    work = Path(tempfile.mkdtemp(prefix="dsh-tb-probe-"))
    client = Marionette(DEFAULT_PORT)
    try:
        for attempt in range(15):
            try:
                client.send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})
                break
            except MarionetteError:
                if attempt == 14:
                    raise
                import time
                time.sleep(2)
        client.send("Marionette:SetContext", {"value": "chrome"})
        print(f"probes in {work}\n")
        for name, manifest in VARIANTS.items():
            xpi = build(name, manifest, work)
            result = client.send("WebDriver:ExecuteAsyncScript", {
                "script": PROBE_SCRIPT,
                "args": [str(xpi)],
                "sandbox": "system",
                "newSandbox": True,
                "scriptTimeout": 60000,
            })
            print(f"{name:20} {result.get('value') if isinstance(result, dict) else result}")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
