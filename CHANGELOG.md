# Changelog

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
