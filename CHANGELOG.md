# Changelog

## Unreleased

### Added

- **Grouping for AI agents:** `groupBy` and `aggregate` of the MCP tools `gdx_read_symbol` and
  `gdx_compare_scenarios` combine the records into one row per group of dimensions (sum, mean, min, max or count,
  as in the table view), e.g. the total per region of a symbol with millions of records, or per scenario. Filters
  select the records first; sorting and paging apply to the groups.
- **git diff of GDX files as text:** **GDX: Set Up Git Diff for GDX Files…** lets `git diff`, `git log -p` and
  `git show` show GDX files in the format of gdxdump, with the declaration of the symbol in the header of each
  change, for one repository (`.gitattributes`) or all of them. It needs neither GAMS nor GAMSPy and keeps working
  after updates of the extension. Files that are not GDX files (e.g. Git LFS pointers) are shown as they are.
- **Command line:** `node out/cli.js dump <file> [<symbol>] [--csv]` writes the text of gdxdump without GAMS.

## 0.10.1

### Added

- **Heatmap in the viewer and comparisons** (like GAMS Studio's): **Heatmap** colors the numbers of the list and
  table view by value, each field on its own scale, of all records or of the filtered ones. Aggregated cells are
  colored on the scale of the aggregated cells.
- **Selected first** in label filters lists the selected labels before the others (setting
  `gdxAnalyzer.labelFilter.selectedFirst`).
- **Default view of symbols:** settings `gdxAnalyzer.defaultView` (list or table view) and
  `gdxAnalyzer.defaultFields` (the fields of variables and equations shown) apply to symbols shown for the first
  time and after **Reset**.
- **GDX: Auto-Fit Columns** (Ctrl+R in the viewer and comparisons, as in GAMS Studio).
- **Save Symbols as GDX…** (in the export dialog of the viewer, the Explorer and the Command Palette): copies
  symbols into a new GDX file, all of their records or those passing the filters of their views, with their types,
  texts, comments, domains, set element texts, acronyms and exact values.
- **Create GDX from CSV/Excel…** (in the Explorer and the Command Palette): makes a GDX file of a CSV file or an
  Excel sheet, like csv2gdx, asking for the columns with labels and the type of the symbol.

### Fixed

- **Auto-fit columns** did not narrow columns that had been widened by longer values while scrolling.

## 0.10.0

### Added

- **Solution report:** the solution status of all variables and equations of a file at once: the records outside
  their bounds (farthest outside first), the binding constraints (largest |marginal| first), and per symbol the
  records outside their bounds, with a non-zero marginal and at their bounds. Click a record or a count to open the
  symbol with that solution status filter. **GDX: Show Solution Report**, or **Solution Report** in the viewer.
- **MCP tool `gdx_solution_report`:** the same report for AI agents, e.g. to find out why a model is infeasible.
- **Hover previews in GAMS and Python source:** a GDX file name shows the symbols of the file, and a symbol name
  (in `$load`, `execute_unload` etc., or any name in a document that references GDX files) its first records, a
  summary of its values and its solution status, with a link to the viewer. In GAMSPy and GAMS Transfer code, a
  Python name previews the symbol it is bound to (`limit = Equation(m, name="supply")`, `cap = m.addParameter("a")`).
  Setting `gdxAnalyzer.hover.enabled`.
- **GAMSPy and GAMS Transfer symbols are links:** those of `read()`, `write()` and `loadRecordsFromGdx()`
  (`symbol_names=`, `symbols=` or a list after the file) and `m["x"]` of a container read from a file.
- **Notebooks:** links, hovers and **GDX: Show Symbol in GDX File** also find the GDX files read in other cells.
- **No GAMS tools needed:** GDX files are read, compared and dumped by the extension itself instead of gdxdump and
  gdxdiff, with the same results, so every feature works on any platform without GAMS.
  - Reading is 5 to 9 times faster (10 million records in 0.4 s instead of 3.8 s). The GDX file formats 5 to 7 are
    read, compressed or not.
  - Comparisons give gdxdiff's summary and difference file, with all its options, and are as fast; with the reading
    of the differences about twice as fast as before.
  - Text dumps (**Dump to Text**, the text diff of comparisons) and **Export Symbol to CSV** are written in gdxdump's
    format, as fast.
  - Setting `gdxAnalyzer.useGamsTools` (and `GDX_USE_GAMS_TOOLS=1` for the MCP server) uses gdxdump and gdxdiff
    instead.

### Changed

- **One package for all platforms:** the packages no longer include gdxdump and gdxdiff (the extension does not
  need them). With `gdxAnalyzer.useGamsTools`, those of a GAMS installation or of GAMSPy are used; the `bundled`
  value of `gdxAnalyzer.backend` is gone (a saved one means `auto`).

### Fixed

- The MCP server exited when its client closed its input, before answering the requests still in progress.
- The universe of files with more than 999 unique elements showed 0 labels (gdxdump writes the count as 1,000).
- Text dumps of files with acronyms declare all of them (gdxdump writes an empty first one and leaves out the last).

## 0.9.1

### Added

- **Scenario comparison for AI agents:** the MCP tool `gdx_compare_scenarios` lists the symbols of several GDX files,
  or returns one symbol across them with Δ and Δ% from a base scenario, with filters, solution status, sorting by
  magnitude and paging.
- **Comparing two Git revisions** of a GDX file with each other (e.g. HEAD~1 and HEAD, or a commit and the working
  tree): **Compare with Git Revision… → Two Revisions…**. Keybindings can pass two refs as arguments.

### Changed

- Totals and aggregated cells leave the sums of the bounds and scale of variables and equations empty, as for Δ%;
  mean, min, max and count still show them. Copy as Code notes that pandas sums them.
- The table view leaves out columns without any value, such as the differences of the base scenario in a scenario
  comparison.

## 0.9.0

### Added

- **Scenario comparison:** compare a symbol across any number of GDX files, side by side in the table view, with the
  difference (Δ) and relative difference (Δ%) from a base scenario you choose. Charts show a series per scenario.
  Select the files in the Explorer and choose **Compare Scenarios…**.
- **Git:** **Compare with Git Revision…** compares a GDX file with its last commit, its staged version or any commit
  of its history. Clicking a changed GDX file in Source Control shows both versions in the viewer.
- **Solution status filter** for variables and equations: records with a non-zero marginal (binding constraints),
  at their lower or upper bound, outside their bounds (infeasible), or not at their defaults, with the number of
  records of each.
- **Aggregation and totals in the table view:** drag dimensions to *Aggregated* to combine their records with sum,
  mean, min, max or count, and add a total row and total columns.
- **Relative differences in comparisons:** a Δ% column (in percent of file 1) next to each Δ column, also in charts.
- **Sorting by magnitude:** a third click on the header of a number column sorts by absolute value, largest first,
  e.g. to find the largest changes.
- **Links from GAMS and Python source:** GDX file names (`$gdxIn`, `execute_unload`, `Container("out.gdx")`, …) open
  the file in the viewer, and the symbols of `$load`, `execute_load`, `execute_unload` and similar statements open it
  at that symbol. **GDX: Show Symbol in GDX File** opens the symbol under the cursor. Setting
  `gdxAnalyzer.links.enabled`.
- **Copy as Code:** Python code that reads a symbol with GAMS Transfer or GAMSPy into a pandas DataFrame, with the
  filters, solution status, sorting, fields and table view of the viewer.
- **MCP tools:** `gdx_read_symbol` and `gdx_symbol_stats` take a solution status filter; `gdx_compare` returns Δ% and
  sorts by any column, also by magnitude.

### Changed

- **Compare GDX Files** with more than two files compares them as scenarios (instead of a warning).
- Enter and double-click move a dimension of the table view through rows, columns and aggregated.
- `.gms` files open in the GAMS language mode (needed for the links when no GAMS extension is installed).
- The extension also starts for GAMS and Python files, for the links.

### Fixed

- The viewer forgot the last choices of the Export dialog when it saved its view.
- GDX files of other file systems (such as Git revisions in a diff editor) open in the viewer through a temporary
  copy instead of an error.

## 0.8.1 and earlier

See the [commit history](https://github.com/mabdullahsoyturk/GDX-Analyzer/commits/master).
