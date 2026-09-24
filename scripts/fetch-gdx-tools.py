#!/usr/bin/env python3
"""Extracts gdxdump, gdxdiff and the libraries they load from the gamspy_base wheels on PyPI into
tools/<platform>, for bundling with the extension (see scripts/package.sh and .gitlab-ci.yml).

usage: scripts/fetch-gdx-tools.py [--version X.Y.Z] [--out tools] [platform ...]

Platforms: linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64 (default: all). The wheels
are checked against the SHA-256 digests PyPI lists and cached in <out>/.cache. The tools of the
platform the script runs on are smoke-tested. Only the Python standard library is needed.
"""

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

# The gamspy_base (GAMS) release whose tools are bundled.
DEFAULT_VERSION = "54.4.0"

# Per platform: the wheel, and the files the tools need. The libraries are the dependency closure
# of gdxdump, gdxdiff and the GDX library within the wheel (their ELF/Mach-O/PE import tables);
# everything else they load comes with the operating system.
TARGETS = {
    "linux-x64": ("manylinux_2_28_x86_64", ["gdxdump", "gdxdiff", "libgdxcclib64.so", "libstdc++.so.6", "libgcc_s.so.1"]),
    "linux-arm64": ("manylinux_2_28_aarch64", ["gdxdump", "gdxdiff", "libgdxcclib64.so", "libstdc++.so.6", "libgcc_s.so.1"]),
    "darwin-x64": ("macosx_10_15_x86_64", ["gdxdump", "gdxdiff", "libgdxcclib64.dylib", "libstdc++.6.dylib", "libgcc_s.1.1.dylib"]),
    "darwin-arm64": ("macosx_11_0_arm64", ["gdxdump", "gdxdiff", "libgdxcclib64.dylib"]),
    "win32-x64": (
        "win_amd64",
        ["gdxdump.exe", "gdxdiff.exe", "gdxcclib64.dll", "msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll", "libmmd.dll"],
    ),
}

ROOT = Path(__file__).resolve().parent.parent


def host_target():
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    system = {"Linux": "linux", "Darwin": "darwin", "Windows": "win32"}.get(platform.system())
    return f"{system}-{arch}" if system else None


def wheel_urls(version):
    with urllib.request.urlopen(f"https://pypi.org/pypi/gamspy-base/{version}/json") as r:
        info = json.load(r)
    return {f["filename"]: (f["url"], f["digests"]["sha256"]) for f in info["urls"]}


def download(url, sha256, dest):
    if dest.exists() and hashlib.sha256(dest.read_bytes()).hexdigest() == sha256:
        return
    print(f"Downloading {dest.name}")
    tmp = dest.with_suffix(".part")
    urllib.request.urlretrieve(url, tmp)
    digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
    if digest != sha256:
        tmp.unlink()
        sys.exit(f"{dest.name}: SHA-256 {digest} does not match {sha256} listed by PyPI")
    tmp.replace(dest)


def extract(wheel, files, out, version):
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    with zipfile.ZipFile(wheel) as z:
        for name in files + ["EULA.md"]:
            with z.open(f"gamspy_base/{name}") as src, open(out / name, "wb") as dst:
                shutil.copyfileobj(src, dst)
            (out / name).chmod(0o644 if name.endswith((".md", ".dll")) else 0o755)
    (out / "VERSION").write_text(f"GAMS {version}\n")


def smoke_test(out):
    exe = ".exe" if platform.system() == "Windows" else ""
    fixtures = ROOT / "test" / "fixtures"
    symbols = subprocess.run([str(out / f"gdxdump{exe}"), str(fixtures / "transport1.gdx"), "Symbols"], capture_output=True, text=True)
    if symbols.returncode != 0 or " x " not in symbols.stdout:
        sys.exit(f"gdxdump smoke test failed:\n{symbols.stdout}{symbols.stderr}")
    with tempfile.TemporaryDirectory() as tmp:
        # From the output's directory: gdxdiff writes a temporary file there and renames it.
        args = [str(out / f"gdxdiff{exe}"), str(fixtures / "transport1.gdx"), str(fixtures / "transport2.gdx"), os.path.join(tmp, "diff.gdx")]
        diff = subprocess.run(args, capture_output=True, text=True, cwd=tmp)
    if diff.returncode != 1 or "Data are different" not in diff.stdout:
        sys.exit(f"gdxdiff smoke test failed (exit code {diff.returncode}):\n{diff.stdout}{diff.stderr}")
    print(f"Smoke test of {out} passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", default=os.environ.get("GAMSPY_BASE_VERSION", DEFAULT_VERSION))
    parser.add_argument("--out", default=str(ROOT / "tools"))
    parser.add_argument("targets", nargs="*", metavar="platform", help=", ".join(TARGETS))
    args = parser.parse_args()
    unknown = [t for t in args.targets if t not in TARGETS]
    if unknown:
        parser.error(f"unknown platform {', '.join(unknown)} (choose from {', '.join(TARGETS)})")
    out = Path(args.out)
    cache = out / ".cache"
    cache.mkdir(parents=True, exist_ok=True)
    urls = wheel_urls(args.version)
    for target in args.targets or list(TARGETS):
        tag, files = TARGETS[target]
        filename = f"gamspy_base-{args.version}-py3-none-{tag}.whl"
        if filename not in urls:
            sys.exit(f"PyPI has no {filename}")
        wheel = cache / filename
        download(*urls[filename], wheel)
        extract(wheel, files, out / target, args.version)
        size = sum(f.stat().st_size for f in (out / target).iterdir())
        print(f"{target}: {', '.join(files)} ({size / 1e6:.1f} MB)")
        if target == host_target():
            smoke_test(out / target)


if __name__ == "__main__":
    main()
