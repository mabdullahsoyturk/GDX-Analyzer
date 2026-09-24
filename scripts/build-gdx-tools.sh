#!/usr/bin/env bash
# Builds gdxdump, gdxdiff and the GDX library from the MIT-licensed sources of
# https://github.com/GAMS-dev/gdx for the current platform (Linux or macOS), for bundling
# with the extension (see scripts/package.sh and .gitlab-ci.yml).
#
# usage: scripts/build-gdx-tools.sh <output directory>
#
# Environment:
#   GDX_VERSION   release tag of GAMS-dev/gdx to build (default: 7.12.1)
#   GDX_SRC       an existing checkout to build instead of cloning
#   JOBS          parallel build jobs (default: number of CPUs)
#   MAX_GLIBC     Linux: fail if the tools need a newer glibc than this (default: 2.28, the oldest
#                 VS Code supports); build on an old distribution (e.g. the GAMS builder image)
set -euo pipefail

out=${1:?usage: $0 <output directory>}
mkdir -p "$out"
out=$(cd "$out" && pwd)
version=${GDX_VERSION:-7.12.1}
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
jobs=${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)}

src=${GDX_SRC:-}
if [ -z "$src" ]; then
  src="$work/gdx"
  git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$version" https://github.com/GAMS-dev/gdx.git "$src"
  # Only zlib is needed (the API generator submodule is not public and its output is committed).
  git -C "$src" submodule update --quiet --init --depth 1 zlib
fi

# The vendored zlib, not the system's: the library must not depend on one being installed.
flags=(-DCMAKE_BUILD_TYPE=Release -DNO_TESTS=ON -DNO_EXAMPLES=ON -DCMAKE_DISABLE_FIND_PACKAGE_ZLIB=ON)
case "$(uname -s)" in
  Linux)
    # The C++ runtime is linked statically, so that the tools run on distributions with an older one.
    flags+=("-DCMAKE_EXE_LINKER_FLAGS=-static-libstdc++ -static-libgcc" "-DCMAKE_SHARED_LINKER_FLAGS=-static-libstdc++ -static-libgcc")
    lib=libgdxcclib64.so
    ;;
  Darwin)
    # The oldest macOS that current VS Code versions support.
    flags+=(-DCMAKE_CXX_COMPILER=clang++ -DCMAKE_OSX_DEPLOYMENT_TARGET=11.0)
    lib=libgdxcclib64.dylib
    ;;
  *)
    echo "Unsupported platform $(uname -s); use scripts/build-gdx-tools.ps1 on Windows." >&2
    exit 1
    ;;
esac

cmake -S "$src" -B "$work/build" "${flags[@]}" >"$work/configure.log" || { cat "$work/configure.log"; exit 1; }
cmake --build "$work/build" --target gdxdump gdxdiff gdxcclib64 -j "$jobs" >"$work/build.log" || { tail -50 "$work/build.log"; exit 1; }

mkdir -p "$out"
cp "$work/build/src/tools/gdxdump/gdxdump" "$work/build/src/tools/gdxdiff/gdxdiff" "$work/build/$lib" "$out/"
chmod 755 "$out/gdxdump" "$out/gdxdiff"
if [ "$(uname -s)" = Linux ]; then
  strip --strip-unneeded "$out/gdxdump" "$out/gdxdiff" "$out/$lib"
  need=$(objdump -T "$out/gdxdump" "$out/gdxdiff" "$out/$lib" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1)
  max=${MAX_GLIBC:-2.28}
  if [ "$(printf '%s\n%s\n' "$need" "$max" | sort -V | tail -1)" != "$max" ]; then
    echo "The tools need glibc $need, newer than $max: build them on an older distribution." >&2
    exit 1
  fi
  echo "Needs glibc $need (at most $max allowed)."
else
  strip -x "$out/gdxdump" "$out/gdxdiff" "$out/$lib"
fi
cp "$src/LICENSE" "$out/LICENSE-GDX.txt"
cp "$src/zlib/LICENSE" "$out/LICENSE-zlib.txt"
echo "$version" >"$out/GDX_VERSION"

# Smoke test: the tools must run on their own from the output directory.
"$out/gdxdump" "$root/test/fixtures/transport1.gdx" Symbols | grep -q ' x ' || { echo "gdxdump smoke test failed" >&2; exit 1; }
set +e
# From the output's directory: gdxdiff writes a temporary file there and renames it.
(cd "$work" && "$out/gdxdiff" "$root/test/fixtures/transport1.gdx" "$root/test/fixtures/transport2.gdx" "$work/diff.gdx" >"$work/diff.log")
code=$?
set -e
[ "$code" -eq 1 ] && grep -q 'Data are different' "$work/diff.log" || { cat "$work/diff.log"; echo "gdxdiff smoke test failed (exit code $code)" >&2; exit 1; }
echo "Built GDX $version tools in $out:"
ls -l "$out"
