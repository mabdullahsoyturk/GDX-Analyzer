#!/usr/bin/env bash
# Packages the extension for one platform with its bundled GDX tools, or as a universal package
# without them (which finds GAMS or GAMSPy on the machine).
#
# usage: scripts/package.sh <target> | universal
#   <target>   a VS Code platform (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64) whose
#              tools are in tools/<target> (from scripts/fetch-gdx-tools.py)
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
# vsce points the relative links and images of README.md to the repository in package.json.
args=(--skip-license --no-dependencies)
if [ "$target" = universal ]; then
  out="dist/$name-$version.vsix"
else
  if [ ! -f "tools/$target/gdxdump" ] && [ ! -f "tools/$target/gdxdump.exe" ]; then
    echo "No tools for $target in tools/$target: get them with scripts/fetch-gdx-tools.py first." >&2
    exit 1
  fi
  cp -R "tools/$target" bin
  # CI artifacts may lose the executable bit of the tools and their libraries.
  find bin -type f ! -name '*.md' ! -name '*.dll' ! -name '*.exe' ! -name VERSION -exec chmod 755 {} +
  args+=(--target "$target")
  out="dist/$name-$version-$target.vsix"
fi
npx --no-install vsce package "${args[@]}" -o "$out"
