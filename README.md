# GDX Viewer for VS Code

View, dump and compare [GAMS](https://www.gams.com) GDX files in VS Code. The extension does not read GDX
files itself; it runs the GAMS tools **gdxdump** and **gdxdiff**, either from a GAMS installation or through the
[GAMSPy](https://gamspy.readthedocs.io) CLI (`gamspy gdx dump` / `gamspy gdx diff`).

## Features

- **GDX viewer**: `.gdx` files open in a read-only viewer with a symbol table like GAMS Studio's: entry
  number, name and domain, type including the subtype (e.g. *Positive Variable*, *Singleton Set*), dimension,
  records and explanatory text. Click a column header to sort; *Group by type* shows one table per type. Selecting a symbol shows its
  records in a table that you can sort, filter and page through. Like GAMS Studio, set elements without
  explanatory text show "Y". Variables and equations show level, marginal,
  lower, upper and scale. Special values (`Eps`, `NA`, `+Inf`, `-Inf`, `Undf`) are highlighted and sort correctly.
  The viewer reloads automatically when the file changes, e.g. after a GAMS run. It remembers the view of
  each symbol (filters, sorting, fields, layout, number format, column widths), also after the file is closed,
  as long as the symbol's type and dimension stay the same; *GDX: Reset Viewer State* (also in the Explorer
  context menu) forgets it.
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
  the last column level; use *Fields* to hide some of them. Rows and columns are paged.
- **Search**: the search field above the records highlights all matches (in the table view also row labels
  and column headers); **Enter/F3** and **Shift+Enter/Shift+F3** go to the next and previous match, changing
  pages as needed. Like GAMS Studio, the search is case-insensitive and has toggles for an **exact match** of
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
- **Selecting and copying**: click and drag (or Shift+click, also across pages) to select cells; click row
  numbers, row labels or column headers to select whole rows or columns; use the arrow keys (Shift extends),
  Ctrl+A to select everything and Escape to clear. **Ctrl+C** copies the selection tab-separated, which pastes
  into Excel; right-click for comma-separated copies and, in the table view, copies without row and column
  labels. Copies contain the exact values, and with everything selected all filtered records are copied, not
  only the visible page. The decimal separator of copied numbers is configurable. (GAMS Studio uses
  Ctrl+Shift+C for tab-separated copies; in VS Code that opens an external terminal, so the extension uses
  Ctrl+C for them.) *Copy* in the header copies the selection, or everything if nothing is selected.
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
  settings. A running comparison can be cancelled.

### Ways to compare

- Select two `.gdx` files in the Explorer → right-click → *Compare GDX Files (gdxdiff)*
- Right-click a file → *Select for GDX Compare*, then right-click another → *Compare with Selected GDX*
- *Compare…* in the viewer, or *GDX: Compare GDX Files* from the Command Palette

### Sample files

`samples/base.gdx` and `samples/scenario.gdx` are a pair to try the compare view on. They are generated by
`samples/make_samples.gms` (see the comments at the top of that file).

## Requirements

One of:

- A **GAMS** installation. The extension looks in `gdx.gamsSystemDirectory`, then the `PATH`, then the standard
  install locations (`C:\GAMS\<version>` on Windows, `/Library/Frameworks/GAMS.framework/...` on macOS,
  `/opt/gams/...` and `~/gams*` on Linux).
- **GAMSPy** (`pip install gamspy`). The extension looks in `gdx.gamspyExecutable`, then a `.venv`/`venv` in the
  workspace folders, then the `PATH`.

With `gdx.backend` set to `auto` (the default), GAMS is preferred because gdxdump starts faster than the
Python-based GAMSPy CLI. *GDX: Show Tool Information* shows which tools are in use, and the **GDX** output channel
logs every command the extension runs.

## Settings

| Setting                   | Default | Description                                                          |
| ------------------------- | ------- | -------------------------------------------------------------------- |
| `gdx.backend`             | `auto`  | `auto`, `gams` (gdxdump/gdxdiff) or `gamspy` (GAMSPy CLI)            |
| `gdx.gamsSystemDirectory` |         | GAMS system directory containing gdxdump and gdxdiff                 |
| `gdx.gamspyExecutable`    |         | Path to the `gamspy` executable (or to a virtual environment)        |
| `gdx.maxRowsPerPage`      | `500`   | Records (list view) or rows (table view) per page                    |
| `gdx.maxColumnsPerPage`   | `100`   | Columns per page in the table view                                   |
| `gdx.numberFormat.style`  | `g`     | Default number format: `g` (automatic), `f` (fixed), `e` (scientific) |
| `gdx.numberFormat.precision` | `6` | Significant digits (`g`, `e`: 1-17) or decimals (`f`: 0-14)        |
| `gdx.numberFormat.fullPrecision` | `false` | Show the fewest digits that reproduce values exactly (`g`, `e`) |
| `gdx.numberFormat.squeezeTrailingZeros` | `true` | Remove trailing zeros after the decimal point              |
| `gdx.squeezeDefaults`    | `false` | Hide variable/equation fields with default values only           |
| `gdx.rememberViewState`  | `true`  | Remember the view of each file after it is closed                  |
| `gdx.copy.decimalSeparator` | `period` | Decimal separator of copied numbers: `period`, `system` or `custom` |
| `gdx.copy.customDecimalSeparator` | `,` | Separator used with `custom`                                   |
| `gdx.diff.eps`            | `0`     | Absolute tolerance for gdxdiff (`Eps`); 0 uses the tool default      |
| `gdx.diff.relEps`         | `0`     | Relative tolerance for gdxdiff (`RelEps`); 0 uses the tool default   |
| `gdx.diff.field`          | `All`   | Variable/equation field to compare (`L`, `M`, `Lo`, `Up`, ...)       |
| `gdx.diff.ignoreSetText` | `false` | Do not compare set element texts (`SetDesc=N`)                    |
| `gdx.diff.compareDefaults` | `false` | Report default values found in one file only (`CmpDefaults`)  |
| `gdx.diff.compareDomains` | `false` | Also compare symbol domains (`CmpDomains`)                           |
| `gdx.diff.ignoreOrder`    | `false` | Ignore the UEL order of the input files (`IgnoreOrder`)              |

## Limitations

- Only files on the local file system are supported, because the tools are run as local processes.
- With the GAMSPy backend, file names must end in lower-case `.gdx`; the GAMSPy CLI appends `.gdx` to any other
  name.

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
