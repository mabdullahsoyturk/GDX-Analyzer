# GDX Analyzer for VS Code

> An independent, unofficial extension by Muhammet Soyturk. It is not made, endorsed or supported by
> GAMS Software GmbH; GAMS and GAMSPy are their products.

View, dump and compare [GAMS](https://www.gams.com) GDX files in VS Code. The extension does not read GDX
files itself; it runs the tools **gdxdump** and **gdxdiff**. The packages for Windows, macOS and Linux include
them, taken from the [gamspy_base](https://pypi.org/project/gamspy-base/) package of GAMS, so nothing else needs
to be installed. The extension can also use the tools of a GAMS installation or the
[GAMSPy](https://gamspy.readthedocs.io) CLI (`gamspy gdx dump` / `gamspy gdx diff`).

## Features

- **GDX viewer**: `.gdx` files open in a read-only viewer with a symbol table like GAMS Studio's: entry
  number, name and domain, type including the subtype (e.g. *Positive Variable*, *Singleton Set*), dimension,
  records and explanatory text. Click a column header to sort; *Group by type* shows one table per type. Selecting a symbol shows its
  records in a table that you can sort, filter and scroll through continuously (the records are loaded while
  scrolling, so symbols with millions of records stay fast; arrow keys, PageUp/PageDown and Ctrl+Home/End move
  through all of them). Like GAMS Studio, set elements without
  explanatory text show "Y". Variables and equations show level, marginal,
  lower, upper and scale. Special values (`Eps`, `NA`, `+Inf`, `-Inf`, `Undf`) are highlighted and sort correctly.
  The viewer reloads automatically when the file changes, e.g. after a GAMS run. It remembers the view of
  each symbol (filters, sorting, fields, layout, number format, column widths), also after the file is closed,
  as long as the symbol's type and dimension stay the same; *GDX: Reset Viewer State* (also in the Explorer
  context menu) forgets it.
- **Universe**: like GAMS Studio, the first entry of the symbol table (`*`, entry 0) lists all unique
  elements (UELs) of the file in GDX order with their UEL numbers. It can be sorted, filtered, searched and
  copied like any symbol.
- **Encoding**: GDX files store labels and explanatory texts as the bytes GAMS wrote, so a file created from
  sources in a legacy encoding (e.g. Latin-1) shows wrong characters when read as UTF-8. Set `gdxAnalyzer.encoding`, or
  use *GDX: Select Encoding of Labels…*, to read them in another encoding; open viewers, comparisons and
  gdxdump documents are read again.
- **Squeeze defaults**: *Fields* can hide the fields of variables and equations that have their default value
  in every record (for the variable type, e.g. an upper bound of 1 for binary variables). gdxdump does not
  report equation types, so for equations the type is inferred from the bounds of the records.
- **Column order**: drag a column header of the list view to another position (or press Alt+←/→ on a focused
  header). Like GAMS Studio, key columns show their original index position as a superscript. The order is
  used by copying, the search and the Excel export too.
- **Column widths**: drag the right edge of a column header to resize it; double-click it (or use *Auto-fit
  columns* in the context menu) to fit the content again.
- **Table view**: symbols with two or more dimensions can be shown as a table with some dimensions as rows and
  the others as columns (by default the last one). Drag the dimension chips between *Rows* and *Columns* to
  rearrange them (or press Enter on a chip to move it, Alt+←/→ to reorder), or swap rows and columns with ⇄.
  Labels are in the order of the GDX file. For variables and equations the fields (level, marginal, ...) form
  the last column level; use *Fields* to hide some of them. Rows scroll continuously; very wide tables page their columns.
- **Charts**: *Chart* (next to *List* and *Table*) shows the filtered records as horizontal **bars** (compare
  magnitudes), **lines** (trends along an ordered dimension such as time) or a **heatmap** (two dimensions).
  Choose the dimension along the category axis, the series (one per label) and, for variables and equations,
  the field. Other dimensions are summed, EPS counts as 0, and NA, ±INF and UNDF are left out; notes above the
  chart say so. Labels are in GDX order. Bar and line charts show up to 8 series (the others are summed as
  *Other*) and 500 categories; hovering (or the arrow keys) shows the exact values. Colors follow the VS Code
  theme (light or dark) and are colorblind-safe; a heatmap uses one hue, or blue and red around 0 when values
  have both signs. *Image* saves the chart as PNG (at twice the resolution) or SVG, or copies it as PNG, with
  the symbol, what is plotted, the file name and the notes as a title; the whole chart is included, also the
  part scrolled out of view.
- **Search**: the search field above the records highlights all matches (in the table view also row labels
  and column headers); **Enter/F3** and **Shift+Enter/Shift+F3** go to the next and previous match, changing
  scrolling as needed. Like GAMS Studio, the search is case-insensitive and has toggles for an **exact match** of
  the whole cell and for **regular expressions** (otherwise `*` and `?` are wildcards). A third toggle
  **filters rows** instead of highlighting. Numbers are matched as displayed. The symbol list has the same
  search; it searches names only unless **all columns** (type, domain and explanatory text) is on. **Ctrl+F**
  focuses the symbol search or the record search.
- **Column filters**: the funnel icon in a column header (or on a dimension chip) opens a filter. Label columns
  get a checklist with search (like GAMS Studio, the search selects the matching labels), *All* / *Invert* /
  *None*, Ctrl+click to show a single label and Shift+click for ranges. Numeric columns get a min/max range that
  can be excluded, and check boxes to show or hide EPS, NA, +INF, -INF and UNDF. Filters apply to both views
  and to the comparison view.
- **Number format**: like GAMS Studio, numbers are shown in *g* format (fixed or scientific depending on the
  magnitude, with a number of significant digits), *f* format (fixed number of decimals) or *e* format
  (scientific). *Full* precision shows the fewest digits that reproduce the stored value exactly, and trailing
  zeros can be squeezed. The defaults come from the settings; *Format* changes them per symbol. Values are read
  exactly (gdxdump `dFormat=hexBytes`), so sorting, filters and *Copy* use the exact values, and hovering a
  rounded value shows it exactly.
- **gdxdump output**: *GDX: Dump to Text* opens the gdxdump output of the whole file, and *GDX: Dump Symbol to
  Text* opens the output for one symbol. Both are read-only documents that refresh when the GDX file changes.
- **Selecting and copying**: click and drag (or Shift+click, also far apart) to select cells; click row
  numbers, row labels or column headers to select whole rows or columns; use the arrow keys (Shift extends),
  Ctrl+A to select everything and Escape to clear. **Ctrl+C** copies the selection tab-separated, which pastes
  into Excel; right-click for comma-separated copies and, in the table view, copies without row and column
  labels. Copies contain the exact values, and with everything selected all filtered records are copied, not
  only the visible page. The decimal separator of copied numbers is configurable. (GAMS Studio uses
  Ctrl+Shift+C for tab-separated copies; in VS Code that opens an external terminal, so the extension uses
  Ctrl+C for them.) *Copy* in the header copies the selection, or everything if nothing is selected.
- **Selection statistics**: like a spreadsheet, the status bar shows *Sum*, *Average* and *Count* of the numbers
  in the selected cells (two or more) of the viewer and the comparison view; its tooltip adds the minimum, the
  maximum and the number of special values, which are not counted as numbers. The statistics use the exact
  values of all selected cells, also those scrolled out of view, and are shown in the number format of the view.
- **Export to Excel**: *Export…* in the viewer (or *GDX: Export to Excel…*) writes the chosen symbols to an
  `.xlsx` file, one sheet per symbol, laid out like its view (list or table view) with exact values. Options:
  apply the filters of each symbol, include hidden fields, and how special values are written (e.g. EPS as 0).
  *Save Connect Instructions…* writes the equivalent GAMS Connect instructions (GDXReader, Filter,
  Projection, ExcelWriter) to run with `gamsconnect`; what Connect cannot express (the text search, filters
  on set texts, the sort order) is noted in comments. No GAMS installation is needed for the Excel export
  itself.
- **Export CSV**: save all records of a symbol as CSV.
- **Compare (gdxdiff)**: compare two GDX files and get a list of differing symbols with gdxdiff's status. For
  each symbol you see the differing records with the values from both files and their difference. Records that
  exist in only one file are marked. *Text Diff* opens VS Code's diff editor on the gdxdump output of both files
  or of one symbol. The difference GDX written by gdxdiff can be opened or saved. *Options…* sets all gdxdiff
  options for a comparison (tolerances, field, field only, diff only, ignoring set texts, comparing
  defaults or domains, ignoring the UEL order, comparing only or skipping symbols); the defaults come from the
  settings. A running comparison can be cancelled. *Chart* shows the differences of a symbol like the viewer's
  charts: by default the differences (Δ = file 2 − file 1) as bars colored by their sign (blue: higher in
  file 2, red: lower), or the values of both files side by side (*Value: … file 1 and file 2*), or a heatmap of
  the differences over two dimensions; charts can be saved as images here too.

- **AI agents (MCP)**: the extension includes an MCP server that gives AI agents read-only access to GDX
  files, see [AI agents](#ai-agents-mcp).

### Ways to compare

- Select two `.gdx` files in the Explorer → right-click → *Compare GDX Files (gdxdiff)*
- Right-click a file → *Select for GDX Compare*, then right-click another → *Compare with Selected GDX*
- *Compare…* in the viewer, or *GDX: Compare GDX Files* from the Command Palette

### AI agents (MCP)

The extension includes an [MCP](https://modelcontextprotocol.io) server with read-only tools for GDX files, so
that AI agents can inspect model data and solutions without parsing gdxdump output:

| Tool | What it does |
| --- | --- |
| `gdx_list_symbols` | Symbols of a file: name, type (e.g. *Positive Variable*), dimension, domain, records, text |
| `gdx_read_symbol` | Records of a symbol as CSV with exact values: filters by label or value range, text search, sorting, fields, paging. `*` reads the universe |
| `gdx_symbol_stats` | Per dimension the distinct labels, per value column count, sum, mean, min, max, zeros and special values |
| `gdx_compare` | gdxdiff of two files: the differing symbols, or the differing records of one symbol with both values and their difference |

- **VS Code chat**: the server is registered with VS Code (*GDX* in the MCP server list), so agent mode can use it
  directly. It uses the same tools (GAMS or GAMSPy) and encoding as the viewer.
- **Other agents** (Claude Code, Cursor, Claude Desktop, ...): *GDX: Copy MCP Server Configuration for AI
  Agents…* copies a `claude mcp add` command or a JSON `mcpServers` entry. The server runs with Node.js
  (`node <extension>/out/mcp.js`) and reads `GDX_BACKEND`, `GDX_GAMS_SYSTEM_DIRECTORY`, `GDX_GAMSPY_EXECUTABLE` and
  `GDX_ENCODING` from its environment. The path contains the extension version, so copy the configuration again
  after updating the extension.

Relative file paths are resolved against the server's working directory (the first workspace folder in VS Code).

### Sample files

`samples/base.gdx` and `samples/scenario.gdx` are a pair to try the compare view on. They are generated by
`samples/make_samples.gms` (see the comments at the top of that file).

## Requirements

VS Code 1.101 or later. The packages for Windows (x64), macOS (Intel and Apple silicon) and Linux (x64 and arm64)
bundle gdxdump and gdxdiff. On other platforms, or with `gdxAnalyzer.backend` set to `gams` or `gamspy`, the
extension uses one of:

- A **GAMS** installation. The extension looks in `gdxAnalyzer.gamsSystemDirectory`, then the `PATH`, then the standard
  install locations (`C:\GAMS\<version>` on Windows, `/Library/Frameworks/GAMS.framework/...` on macOS,
  `/opt/gams/...` and `~/gams*` on Linux).
- **GAMSPy** (`pip install gamspy`). The extension looks in `gdxAnalyzer.gamspyExecutable`, then a `.venv`/`venv` in the
  workspace folders, then the `PATH`.

With `gdxAnalyzer.backend` set to `auto` (the default), the bundled tools are used if the package has them, then
GAMS, which is preferred to GAMSPy because gdxdump starts faster than the Python-based GAMSPy CLI. Set it to `gams`
to use the tools of a particular GAMS version. *GDX: Show Tool Information* shows which tools are in use, and the **GDX** output channel
logs every command the extension runs.

## Settings

| Setting                   | Default | Description                                                          |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `gdxAnalyzer.backend`             | `auto`  | `auto`, `bundled`, `gams` (gdxdump/gdxdiff of GAMS) or `gamspy` (GAMSPy CLI) |
| `gdxAnalyzer.gamsSystemDirectory` |         | GAMS system directory containing gdxdump and gdxdiff                 |
| `gdxAnalyzer.gamspyExecutable`    |         | Path to the `gamspy` executable (or to a virtual environment)        |
| `gdxAnalyzer.encoding`            | `utf-8` | Encoding of labels and texts in GDX files, e.g. `windows-1252`      |
| `gdxAnalyzer.maxRowsPerPage`      | `500`   | Records (list view) or rows (table view) loaded at once while scrolling |
| `gdxAnalyzer.maxColumnsPerPage`   | `100`   | Columns per page in the table view                                   |
| `gdxAnalyzer.numberFormat.style`  | `g`     | Default number format: `g` (automatic), `f` (fixed), `e` (scientific) |
| `gdxAnalyzer.numberFormat.precision` | `6` | Significant digits (`g`, `e`: 1-17) or decimals (`f`: 0-14)        |
| `gdxAnalyzer.numberFormat.fullPrecision` | `false` | Show the fewest digits that reproduce values exactly (`g`, `e`) |
| `gdxAnalyzer.numberFormat.squeezeTrailingZeros` | `true` | Remove trailing zeros after the decimal point              |
| `gdxAnalyzer.squeezeDefaults`    | `false` | Hide variable/equation fields with default values only           |
| `gdxAnalyzer.rememberViewState`  | `true`  | Remember the view of each file after it is closed                  |
| `gdxAnalyzer.copy.decimalSeparator` | `period` | Decimal separator of copied numbers: `period`, `system` or `custom` |
| `gdxAnalyzer.copy.customDecimalSeparator` | `,` | Separator used with `custom`                                   |
| `gdxAnalyzer.diff.eps`            | `0`     | Absolute tolerance for gdxdiff (`Eps`); 0 uses the tool default      |
| `gdxAnalyzer.diff.relEps`         | `0`     | Relative tolerance for gdxdiff (`RelEps`); 0 uses the tool default   |
| `gdxAnalyzer.diff.field`          | `All`   | Variable/equation field to compare (`L`, `M`, `Lo`, `Up`, ...)       |
| `gdxAnalyzer.diff.ignoreSetText` | `false` | Do not compare set element texts (`SetDesc=N`)                    |
| `gdxAnalyzer.diff.compareDefaults` | `false` | Report default values found in one file only (`CmpDefaults`)  |
| `gdxAnalyzer.diff.compareDomains` | `false` | Also compare symbol domains (`CmpDomains`)                           |
| `gdxAnalyzer.diff.ignoreOrder`    | `false` | Ignore the UEL order of the input files (`IgnoreOrder`)              |

## Large files

Records are kept in the extension host in compact columns (labels stored once, numbers as numbers), and the
webview only receives the rows it shows. Measured with the bundled gdxdump (GAMS 54.4) on a 148 MB GDX file, on an
Intel Core i7-1260P (median of three runs; memory is what a loaded and sorted symbol keeps):

| Symbol | Load | Memory | Sort | Label search | Table view |
| --- | --- | --- | --- | --- | --- |
| 1 million records (2 dims) | 0.3 s | ~22 MB | 0.3 s | 0.02 s | 0.07 s |
| 1 million variable records | 1.0 s | ~58 MB | 0.3 s | 0.04 s | 0.07 s |
| 10 million records (3 dims) | 4.6 s | ~250 MB | 5.2 s | 0.2 s | 0.6 s |

A comparison with 2 million differing records takes about 0.8 seconds for gdxdiff and 1.9 seconds to load, and
keeps about 220 MB. Searching for a number formats every value (about 0.6 seconds per million values). The viewer
and each comparison keep the records of the four most recently used symbols. Copying is limited to 5 million cells
and the Excel export to Excel's limits (1,048,576 rows, 16,384 columns); use filters to reduce larger symbols.

## Limitations

- Only files on the local file system are supported, because the tools are run as local processes.
- With the GAMSPy backend, file names must end in lower-case `.gdx`; the GAMSPy CLI appends `.gdx` to any other
  name.

## Bundled tools and packaging

`scripts/fetch-gdx-tools.py` extracts gdxdump, gdxdiff, the GDX library and the runtime libraries they load from
the [gamspy_base](https://pypi.org/project/gamspy-base/) wheels (`GAMSPY_BASE_VERSION`, default 54.4.0) into
`tools/<platform>` for all platforms, checking the wheels against the digests on PyPI, and smoke-tests the tools of
the platform it runs on. `scripts/package.sh <platform>` packages the extension with those tools
(`dist/gdx-analyzer-<version>-<platform>.vsix`), `scripts/package.sh universal` without them:

```sh
python3 scripts/fetch-gdx-tools.py
scripts/package.sh linux-x64
```

The GitLab pipeline (`.gitlab-ci.yml`) fetches the tools, smoke-tests them on the `linux-arm64`, `macos`,
`macos-arm64` and `windows` runners, runs the unit tests with the Linux tools, packages all platforms and, on a tag
matching the version, publishes to the Visual Studio Marketplace and Open VSX (manual jobs; CI/CD variables
`VSCE_PAT` and `OVSX_PAT`). The bundled tools are subject to the GAMS license included with them (`bin/EULA.md`);
see `THIRD_PARTY_NOTICES.md`.

## Development

```sh
npm install
npm run compile        # or: npm run watch
npm test               # unit tests; also runs gdxdump/gdxdiff through each backend that is installed
npm run test:integration   # tests inside a VS Code extension host
npm run package        # builds a .vsix
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with `test/fixtures` open.

Environment variables for the tests:

- `GDX_TEST_GAMS_DIR`: GAMS system directory for the GAMS backend tests (auto-detected otherwise)
- `GDX_TEST_GAMSPY`: gamspy executable for the GAMSPy backend tests (auto-detected otherwise). Also enables the
  GAMSPy integration test.
- `VSCODE_EXECUTABLE`: use an installed VS Code for the integration tests instead of downloading one

The fixtures in `test/fixtures` are generated with `make_fixtures.gms` (`--variant=1` / `--variant=2`),
`make_edge_fixture.gms` and `make_types_fixture.gms` (all variable types and equation types).

### Layout

| Path             | Contents                                                                      |
| ---------------- | ----------------------------------------------------------------------------- |
| `src/tools.ts`   | Locating the tools; argument building for both backends; running processes    |
| `src/format.ts`  | Number formats (g/f/e, precision) and decoding of exact gdxdump values        |
| `src/parse.ts`   | Parsers for gdxdump (symbols, domains, CSV) and gdxdiff output                |
| `src/table.ts`   | Host-side sorting, filters, paging and pivoting; tables for symbols and diffs |
| `src/query.ts`   | Answers the webviews' table queries and copy requests (search, paging)        |
| `src/defaults.ts` | Default values of variable and equation fields (squeezing)                  |
| `src/export.ts`  | Excel export and GAMS Connect instructions                                    |
| `src/xlsx.ts`    | Minimal .xlsx writer (no dependencies)                                        |
| `src/viewState.ts` | Saved views of GDX files                                                    |
| `src/search.ts`  | Search rules (wildcards, exact match, regular expressions)                    |
| `src/tableHost.ts` | Settings and clipboard for the queries                                      |
| `src/viewer.ts`  | Custom editor for `.gdx` files                                                |
| `src/diff.ts`    | gdxdiff result panel                                                          |
| `src/dump.ts`    | Read-only `gdxdump:` documents                                                |
| `media/`         | Webview scripts and styles                                                    |
