# Builds gdxdump, gdxdiff and the GDX library from the MIT-licensed sources of
# https://github.com/GAMS-dev/gdx on Windows (MSVC, CMake and Ninja on the PATH), for bundling
# with the extension. See scripts/build-gdx-tools.sh for Linux and macOS.
#
# usage: scripts\build-gdx-tools.ps1 <output directory>
#
# Environment: GDX_VERSION (default 7.12.1), GDX_SRC (an existing checkout instead of cloning).
param([Parameter(Mandatory = $true)][string]$Out)
$ErrorActionPreference = 'Stop'

$version = if ($env:GDX_VERSION) { $env:GDX_VERSION } else { '7.12.1' }
$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("gdx-tools-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path

function Invoke-Checked([string]$what, [scriptblock]$block) {
  & $block
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)" }
}

try {
  $src = $env:GDX_SRC
  if (-not $src) {
    $src = Join-Path $work 'gdx'
    Invoke-Checked 'git clone' { git -c advice.detachedHead=false clone --quiet --depth 1 --branch $version https://github.com/GAMS-dev/gdx.git $src }
    # Only zlib is needed (the API generator submodule is not public and its output is committed).
    Invoke-Checked 'git submodule' { git -C $src submodule update --quiet --init --depth 1 zlib }
  }

  $build = Join-Path $work 'build'
  # The vendored zlib, and the C++ runtime linked statically (no Visual C++ Redistributable needed).
  Invoke-Checked 'cmake configure' {
    cmake -S $src -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release -DNO_TESTS=ON -DNO_EXAMPLES=ON `
      -DCMAKE_DISABLE_FIND_PACKAGE_ZLIB=ON '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded'
  }
  Invoke-Checked 'cmake build' { cmake --build $build --target gdxdump gdxdiff gdxcclib64 }

  Copy-Item (Join-Path $build 'src\tools\gdxdump\gdxdump.exe'), (Join-Path $build 'src\tools\gdxdiff\gdxdiff.exe'), (Join-Path $build 'gdxcclib64.dll') -Destination $Out
  Copy-Item (Join-Path $src 'LICENSE') (Join-Path $Out 'LICENSE-GDX.txt')
  Copy-Item (Join-Path $src 'zlib\LICENSE') (Join-Path $Out 'LICENSE-zlib.txt')
  Set-Content -Path (Join-Path $Out 'GDX_VERSION') -Value $version -NoNewline

  # Smoke test: the tools must run on their own from the output directory.
  $fixtures = Join-Path $root 'test\fixtures'
  $symbols = & (Join-Path $Out 'gdxdump.exe') (Join-Path $fixtures 'transport1.gdx') Symbols
  if ($LASTEXITCODE -ne 0 -or -not ($symbols -match ' x ')) { throw 'gdxdump smoke test failed' }
  # From the output's directory: gdxdiff writes a temporary file there and renames it.
  Push-Location $work
  try {
    $diff = & (Join-Path $Out 'gdxdiff.exe') (Join-Path $fixtures 'transport1.gdx') (Join-Path $fixtures 'transport2.gdx') (Join-Path $work 'diff.gdx')
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  if ($code -ne 1 -or -not ($diff -match 'Data are different')) { $diff; throw "gdxdiff smoke test failed (exit code $code)" }
  Write-Host "Built GDX $version tools in ${Out}:"
  Get-ChildItem $Out | Format-Table Name, Length
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
