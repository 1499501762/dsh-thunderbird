#!/usr/bin/env python3
"""Install the bridge add-on into Thunderbird with no clicks.

Dropping an .xpi into <profile>/extensions/ no longer works on modern Gecko:
the directory is not scanned and the file is deleted on the next start. The
supported headless path is Marionette -- Thunderbird ships it in release builds.
Start it with `-marionette -remote-allow-system-access`, then drive
AddonManager.getInstallForFile() from a system sandbox. Unsigned add-ons install
because Thunderbird's xpinstall.signatures.required defaults to false.

    python dev/install-extension.py                 # build, install, verify
    python dev/install-extension.py --no-build
    python dev/install-extension.py --profile <dir>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MARIONETTE_TIMEOUT = 90.0
DEFAULT_PORT = 2828

# Runs inside the Marionette system sandbox.
INSTALL_SCRIPT = r"""
const path = arguments[0];
const cb = arguments[arguments.length - 1];
(async () => {
  const out = {};
  try {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    let file;
    try {
      const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
      file = new FileUtils.File(path);
    } catch (e) {
      file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
    }
    out.exists = file.exists();
    if (!out.exists) { out.error = "xpi not found at " + path; cb(JSON.stringify(out)); return; }
    const install = await AddonManager.getInstallForFile(file);
    out.state = install.state;
    out.installError = install.error;
    if (install.error) {
      // -3 is ERROR_CORRUPT_FILE; ask nsIZipReader what it actually sees so the
      // difference between "bad archive" and "bad manifest" is visible.
      try {
        const zr = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(Ci.nsIZipReader);
        zr.open(file);
        const names = [];
        const entries = zr.findEntries("**");
        while (entries.hasMore()) { names.push(entries.getNext()); }
        out.zipProbe = { entries: names, hasManifest: zr.hasEntry("manifest.json") };
        zr.close();
      } catch (e) {
        out.zipProbe = { error: String((e && (e.message || e)) || e) };
      }
      out.error = "getInstallForFile error " + install.error;
      cb(JSON.stringify(out));
      return;
    }
    await install.install();
    const addon = install.addon;
    out.ok = true;
    out.id = addon ? addon.id : null;
    out.version = addon ? addon.version : null;
    out.signedState = addon ? addon.signedState : null;
    out.isActive = addon ? addon.isActive : null;
    out.appDisabled = addon ? addon.appDisabled : null;
    out.location = addon && addon.location ? String(addon.location.name) : null;
  } catch (e) {
    out.error = String((e && (e.message || e)) || e);
  }
  cb(JSON.stringify(out));
})();
"""


def profile_dir(explicit: str | None) -> Path:
    if explicit:
        return Path(explicit)
    root = Path(os.environ["APPDATA"]) / "Thunderbird" / "Profiles"
    candidates = [p for p in root.iterdir() if p.is_dir() and "dev-edition" not in p.name]
    if not candidates:
        raise SystemExit(f"no Thunderbird profile under {root}")
    return max(candidates, key=lambda p: (p / "prefs.js").stat().st_mtime
               if (p / "prefs.js").exists() else p.stat().st_mtime)


def thunderbird_exe() -> Path:
    for candidate in (
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Mozilla Thunderbird" / "thunderbird.exe",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "Mozilla Thunderbird" / "thunderbird.exe",
    ):
        if candidate.is_file():
            return candidate
    raise SystemExit("thunderbird.exe not found")


def stop_thunderbird(proc_name: str = "thunderbird.exe", wait: float = 60.0) -> None:
    def running() -> bool:
        out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {proc_name}"],
                             capture_output=True, text=True).stdout
        return proc_name.lower() in out.lower()

    if not running():
        return
    # Graceful first: Thunderbird needs to flush prefs.js and release
    # parent.lock, and a force-kill can leave the profile needing recovery.
    subprocess.run(["taskkill", "/IM", proc_name], capture_output=True, check=False)
    deadline = time.time() + wait
    while time.time() < deadline:
        if not running():
            return
        time.sleep(1)
    subprocess.run(["taskkill", "/IM", proc_name, "/F"], capture_output=True, check=False)
    deadline = time.time() + 20
    while time.time() < deadline:
        if not running():
            return
        time.sleep(1)
    raise SystemExit("Thunderbird did not exit")


class MarionetteError(RuntimeError):
    pass


class Marionette:
    """Marionette speaks length-prefixed JSON over a plain TCP socket."""

    def __init__(self, port: int, timeout: float = MARIONETTE_TIMEOUT):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.buf = b""
        self.msg_id = 0
        self.hello = self._read_packet()
        print(f"  marionette: {self.hello}")

    def _read_exact(self, count: int) -> bytes:
        while len(self.buf) < count:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise SystemExit("marionette closed the connection")
            self.buf += chunk
        head, self.buf = self.buf[:count], self.buf[count:]
        return head

    def _read_packet(self):
        length = b""
        while True:
            char = self._read_exact(1)
            if char == b":":
                break
            length += char
        return json.loads(self._read_exact(int(length)).decode("utf-8"))

    def send(self, command: str, params: dict):
        self.msg_id += 1
        payload = json.dumps([0, self.msg_id, command, params]).encode("utf-8")
        self.sock.sendall(str(len(payload)).encode("ascii") + b":" + payload)
        while True:
            packet = self._read_packet()
            if isinstance(packet, list) and len(packet) >= 2 and packet[1] == self.msg_id:
                if packet[2]:
                    reason = packet[2].get("error", "error")
                    raise MarionetteError(f"{command} failed [{reason}]: {packet[2].get('message')}")
                return packet[3]

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def marionette_port(profile: Path) -> int:
    """Marionette advertises the port it actually bound in the profile."""
    port_file = profile / "MarionetteActivePort"
    for _ in range(30):
        if port_file.is_file():
            text = port_file.read_text(encoding="utf-8").strip()
            if text.isdigit():
                return int(text)
        time.sleep(0.5)
    return DEFAULT_PORT


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=None)
    parser.add_argument("--no-build", action="store_true")
    parser.add_argument("--keep-running", action="store_true",
                        help="do not stop an already running Thunderbird")
    args = parser.parse_args()

    repo = Path(__file__).resolve().parent.parent
    profile = profile_dir(args.profile)

    if not args.no_build:
        subprocess.run([sys.executable, str(repo / "dev" / "build_xpi.py")], check=True)

    manifest = json.loads((repo / "thunderbird-addon" / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    built = (repo / "dist" / f"dsh-thunderbird-bridge-{version}.xpi").resolve()
    if not built.is_file():
        raise SystemExit(f"missing {built}; run dev/build_xpi.py first")

    # Gecko caches jars by path, so a rebuilt XPI at the same path can be read
    # back as the previous contents. Install from a content-addressed copy.
    digest = hashlib.sha256(built.read_bytes()).hexdigest()[:12]
    xpi = Path(tempfile.gettempdir()) / f"dsh-thunderbird-bridge-{version}-{digest}.xpi"
    shutil.copyfile(built, xpi)
    print(f"  installing {xpi.name}")

    port_file = profile / "MarionetteActivePort"
    if port_file.exists():
        port_file.unlink()

    if not args.keep_running:
        print("stopping Thunderbird ...")
        stop_thunderbird()

    exe = thunderbird_exe()
    print(f"starting {exe.name} -marionette -remote-allow-system-access")
    subprocess.Popen([str(exe), "-marionette", "-remote-allow-system-access"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    port = marionette_port(profile)
    print(f"  profile : {profile}")
    print(f"  port    : {port}")

    client = None
    for attempt in range(20):
        try:
            client = Marionette(port)
            break
        except (OSError, SystemExit) as error:
            if attempt == 19:
                raise SystemExit(f"could not reach Marionette on {port}: {error}")
            time.sleep(2)

    try:
        for attempt in range(15):
            try:
                client.send("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})
                print("  session established")
                break
            except MarionetteError as error:
                if attempt == 14:
                    raise
                print(f"  waiting for a window: {error}")
                time.sleep(2)

        # AddonManager lives in the parent process, so the script has to run in
        # a chrome sandbox. Thunderbird also needs the main window to exist
        # first, hence the retry loop around SetContext.
        for attempt in range(30):
            try:
                client.send("Marionette:SetContext", {"value": "chrome"})
                print("  chrome context set")
                break
            except MarionetteError as error:
                if attempt == 29:
                    raise
                print(f"  waiting for a window: {error}")
                time.sleep(2)

        result = client.send("WebDriver:ExecuteAsyncScript", {
            "script": INSTALL_SCRIPT,
            "args": [str(xpi)],
            "sandbox": "system",
            "newSandbox": True,
            "scriptTimeout": 120000,
        })
        print("=== install result ===")
        print(json.dumps(result, indent=2))
    finally:
        try:
            client.send("WebDriver:DeleteSession", {})
        except Exception:
            pass
        client.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
