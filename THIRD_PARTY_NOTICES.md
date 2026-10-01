# Third-party notices

GDX Analyzer reads, writes, dumps and compares GDX files as the open-source GDX library and its tools do
(https://github.com/GAMS-dev/gdx): `src/gdxReader.ts` and `src/gdxWriter.ts` follow the file format of
`src/gxfile.cpp` and `src/gdlib/gmsstrm.cpp`, including their constants and the default records of variables and
equations; `src/gdxText.ts` follows gdxdump (`src/tools/gdxdump/gdxdump.cpp`, `src/gdlib/strutilx.cpp`) and
`src/gdxDiff.ts` gdxdiff (`src/tools/gdxdiff/gdxdiff.cpp`). The GDX library and its tools are distributed under the
MIT license:

> Copyright (c) 2017-2026 GAMS Software GmbH <support@gams.com>
> Copyright (c) 2017-2026 GAMS Development Corp. <support@gams.com>
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
> permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of
> the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO
> THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
> TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

GDX Analyzer itself is independent and not affiliated with GAMS.
