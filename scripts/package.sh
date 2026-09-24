#!/usr/bin/env bash
# Packages the extension for one platform with its bundled GDX tools, or as a universal package
# without them (which finds GAMS or GAMSPy on the machine).
#
# usage: scripts/package.sh <target> | universal
#   <target>   a VS Code platform (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64) whose
#              tools are in tools/<target> (built by scripts/build-gdx-tools.sh / .ps1)
#
# The packages are written to dist/.
set -euo pipefail

target=${1:?usage: $0 <target> | universal}
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
version=$(node -p "require('./package.json').version")
name=$(node -p "require('./package.json').name")
mkdir -p dist

# Only the tools of the target go into the package.
rm -rf bin
trap 'rm -rf "$root/bin"' EXIT
args=(--skip-license --allow-missing-repository --no-dependencies)
if [ "$target" = universal ]; then
  out="dist/$name-$version.vsix"
else
  if [ ! -x "tools/$target/gdxdump" ] && [ ! -f "tools/$target/gdxdump.exe" ]; then
    echo "No tools for $target in tools/$target: build them with scripts/build-gdx-tools.sh first." >&2
    exit 1
  fi
  cp -R "tools/$target" bin
  args+=(--target "$target")
  out="dist/$name-$version-$target.vsix"
fi
npx --no-install vsce package "${args[@]}" -o "$out"
