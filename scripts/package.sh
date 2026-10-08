#!/usr/bin/env bash
# Packages the extension: one package for all platforms (GDX files are read, compared and dumped by
# the extension itself; gdxdump and gdxdiff of a GAMS or GAMSPy installation are used only on request),
# with the desktop extension (out/) and the web extension for VS Code for the Web (out-web/).
#
# usage: scripts/package.sh
#
# The package is written to dist/.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
version=$(node -p "require('./package.json').version")
name=$(node -p "require('./package.json').name")
mkdir -p dist
npm run compile
node scripts/build-web.mjs --production
# vsce points the relative links and images of README.md to the repository in package.json.
npx --no-install vsce package --skip-license --no-dependencies -o "dist/$name-$version.vsix"
