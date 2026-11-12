# QCAD Tools

Tools for dealing with poorly formed DWG/DXF files that QCAD struggles to open.

Some CAD systems emit drawings containing structures that are legal enough to
load but pathological to render, so a small drawing can take tens of seconds to
open and minutes to plot. These tools strip those structures out of a *copy* of
each drawing, after which the same sheets open in a fraction of a second in
stock QCAD with nothing visible lost.

There are two front ends over one engine:

| | |
|---|---|
| `repair-drawings` | command line: repair a whole folder of incoming drawings, in parallel |
| `addon/RepairDrawings/` | menu entries inside QCAD: repair the open drawing, or pick files |
| `RepairEngine.js` | the shared engine: finds and removes the defects |
| `RepairSlowDrawing.js` | the engine's command line driver, run by `repair-drawings` |
| `install-addon` | installs the add-on into a QCAD installation |

Use the command line for an incoming folder, and the add-on for one or two
drawings or for a drawing you already have open. The command line is much
faster for bulk work; see **Which front end** below.

## Requirements

- **QCAD Pro 3.x** for DWG input — the DWG plugin is Pro-only. The GPL/community
  build works for DXF input.
- Linux, `bash`, `realpath`, `find` (GNU coreutils). Developed against QCAD
  3.32.1 Pro on Linux.

Both front ends find QCAD themselves: they honor `$QCAD_HOME`, then look for
`~/opt/qcad-*-pro-linux-*/qcad` and `/opt/qcad-*/qcad`, then fall back to
`qcad` on `$PATH`.

## Command line

Nothing to build. Clone it and optionally put the wrapper on your `PATH`:

```bash
ln -s "$PWD/repair-drawings" ~/.local/bin/
```

`repair-drawings` locates the scripts next to itself, so a symlink is fine but
the files must stay together in one directory.

```bash
repair-drawings ~/jobs/incoming
#   -> ~/jobs/incoming-repaired/
```

Every `.dwg`/`.dxf` in the folder is repaired in parallel and written to the
output folder **under its original name**, so sheet cross-references and any
downstream scripts keep working.

```
Options:
  -o DIR   output folder            (default: <input folder>-repaired)
  -j N     parallel workers         (default: min(nproc, 8); ~450 MB each)
  -n       dry run: report what would be removed, write nothing
  -f       force: redo files whose repaired copy is already up to date
  -r       recurse into sub-folders
  -q       quiet: summary only
  -h       help

Environment:
  QCAD_HOME   QCAD installation folder (auto-detected if unset)

Exit status: 0 all drawings handled, 1 one or more failed, 2 setup error.
```

### Guarantees

- **Originals are never modified.** The wrapper refuses to run if the output
  folder is also an input folder (exit 2, nothing touched).
- **The output folder is always a complete set.** Drawings that need no repair
  are copied through, so you can point QCAD at the output and ignore the input.
- **Re-running is a no-op.** Drawings whose repaired copy is newer than the
  input are skipped. When new sheets land, run the same command — only the new
  ones are processed.
- **Failures are loud.** A drawing QCAD cannot read is reported as `error`, is
  *not* copied to the output, and sets exit status 1. Per-drawing logs land in
  `<output>/.repair-logs/`.

Exit codes are meaningful, so this drops straight into a Makefile or cron job.

Cost is dominated by QCAD's import of the *unrepaired* file: roughly 80 s and
420 MB of RAM per bad drawing, which is why the worker default is capped at 8.

## Inside QCAD

```bash
./install-addon          # installs into <QCAD_HOME>/scripts/Misc/MiscIO/RepairDrawings
./install-addon -u       # removes it again
```

Restart QCAD afterwards — add-ons are loaded at startup. Two entries appear
under **Misc → Import/Export**:

| entry | command | what it does |
|---|---|---|
| **Repair Current Drawing** | `repairdrawing` | repairs the drawing that is open |
| **Repair Drawing Files...** | `repairfiles` | repairs copies of drawings you pick |

**Repair Current Drawing** is instant, because the drawing is already loaded.
The repair goes onto the undo stack, so Edit > Undo reverses it, and the file
on disk is untouched until you save. This is the one to use when you have
already waited out the slow open.

**Repair Drawing Files...** asks for the drawings, then for a folder to write
the repaired copies into (defaulting to `<folder of the first drawing>-repaired`,
which it creates for you). Copies keep their original names. It refuses to
write into a folder that holds one of the chosen drawings, and it refuses a
selection containing two drawings with the same file name, since the copies
would overwrite each other.

If the installation folder is not writable — a system-wide install under
`/opt` — run `sudo ./install-addon`.

### If a menu entry seems to do nothing

The add-on does **not** need to be on your `PATH` — QCAD loads it from its own
`scripts/` folder, which is where `install-addon` puts it. If the file
selection window appears at all, the add-on is installed correctly.

Every step reports itself in QCAD's command line history at the bottom of the
window, so that is the first place to look: after choosing drawings you should
see `n drawing(s) selected, now choose a folder for the repaired copies`.
Errors are shown in a dialog and repeated there.

For anything that still fails silently, start QCAD from a terminal and watch
its output — QCAD writes script errors there and nowhere else:

```bash
"$(dirname "$(command -v qcad)")"/qcad      # or just: qcad
```

After updating the add-on, run `./install-addon` again and **restart QCAD**:
the installer copies files into the QCAD installation, and QCAD reads add-on
scripts once at startup.

### Which front end

The script engine runs on QCAD's GUI thread. A batch repair therefore blocks
the window while each drawing is imported, the progress dialog cannot repaint
during an import, and there is no parallelism. For a folder of 19 bad sheets
that is roughly 25 minutes in the GUI against about 3 minutes for
`repair-drawings -j 8`. Use the add-on for one or two drawings and for in-place
repair; use the command line for an incoming set.

## What it repairs, and why those things are slow

**1. Recursive viewports.** A `VIEWPORT` entity inside an ordinary (non-layout)
block, where that block is inserted into model space. Rendering the block
renders the viewport, which renders model space, which renders the block again.
QCAD has no cycle detection — only a static depth limit of 16 — so the entire
drawing is rendered 16 times over on every repaint, nested copies appear on top
of the drawing, and the log fills with recursion warnings. A viewport inside a
non-layout block has no meaning (AutoCAD does not draw it either), so it is
deleted. Viewports in real paper-space layouts are left alone.

**2. Blank attribute rows.** Block references to attribute-only blocks (no
drawable geometry, only attribute definitions) whose own attribute values are
all empty — typically the leftover rows of an unfilled BOM or parts-list
template. They draw nothing, but every one is parsed on import and walked on
every repaint, and they can easily account for the overwhelming majority of a
file. References whose attributes are all blank are deleted; where every
reference to such a block is blank, the block definition goes too.

Either defect alone is enough to make a drawing unusable, and they multiply.
Removing both typically takes import, redraw and plot times down by one to two
orders of magnitude and the recursion warnings to zero.

**Nothing visible is lost.** Verified by plotting repaired and unrepaired
versions to PDF and rasterizing at 150 dpi: differences are a few dozen pixels
in millions, all antialiasing on unchanged geometry. The repair also survives
round-tripping — a repaired file opened and re-saved through QCAD comes back
clean.

## Using the engine directly

```bash
cd /path/to/qcad-3.32.1
./qcad -platform offscreen -no-dock-icon -allow-multiple-instances \
       -autostart /path/to/RepairSlowDrawing.js -- \
       [-n] [-k] [-o OUTDIR] FILE [FILE ...]
```

- `-n` dry run: report, write nothing
- `-o OUTDIR` write repaired files here (default: beside the input)
- `-k` keep the original file name instead of appending `-repaired`
  (needs `-o` pointing somewhere else)

Output keeps the input's format: DWG stays DWG, DXF stays DXF.

Each file produces one tab-separated line for scripts to parse:

```
RESULT<TAB>repaired|clean|dryrun|error<TAB>removed<TAB>blocks<TAB>viewports<TAB>in<TAB>out
```

`out` is `-` when nothing was written. This is what the wrapper consumes.

`RepairEngine.js` itself is UI-free and can be included from any QCAD script:

```javascript
include("RepairEngine.js");

var defects = RepairEngine.findDefects(doc);          // survey, changes nothing
RepairEngine.describe(defects);                       // lines of plain text
var res = RepairEngine.repairDocument(di, doc, true); // find + delete, undoable
```

## Five traps for anyone else scripting QCAD

All five of these cost real debugging time here, and all five fail *silently*:

**Relative paths do not work.** QCAD's launcher calls
`QDir::setCurrent(applicationPath)` during startup, so a relative path handed to
it on the command line stops resolving the moment QCAD is up. Every import
fails with an unhelpful error code 3 and the files look corrupt. Resolve inputs
to absolute paths before invoking QCAD — `repair-drawings` runs every input
through `realpath` for exactly this reason.

**`queryEntity()` clones cannot be read.** `doc.queryEntity(id)` returns a clone
whose scripting wrapper exposes no text accessor at all — not even a
`getPlainText` to fail on. A blank-value check written against it sees *every*
attribute as empty, so it would delete filled-in rows. Use
`doc.queryEntityDirect(id).getPlainText()` instead.

**An add-on is a folder whose name matches its script.** QCAD treats any
directory under `<install>/scripts` as an add-on if it contains a `.js` file of
the same name, and calls the global `init(basePath)` in the matching `*Init.js`
at startup. Get the name wrong and the folder is simply ignored, with no
warning. Other files may live in the folder; `include("Other.js")` from the
add-on resolves against `includeBasePath`, which is the folder the including
file is in.

**QCAD's script library is not the same in every release, and an error in an
action is swallowed.** Helpers such as `destrDialog()`, `destr()` and
`getDontUseNativeDialog()` exist in some versions and not others. Calling a
missing one raises a `ReferenceError` that aborts the action, and QCAD writes
that error only to the terminal — from the user's seat the menu entry simply
does nothing. Reach these helpers through a `typeof(...)==="function"` check
with a fallback, as `RepairDrawings.closeDialog()` and friends do, and wrap the
whole action in try/catch so a failure is visible.

**The GUI thread is the script thread.** A long import freezes the window, and
a `QProgressDialog` will not repaint during it even with `processEvents()`.
Set the label text *before* starting each slow step, not after.

## Why repair rather than patch QCAD

The viewport recursion lives in QCAD's GPL core (`RViewportEntity`), which the
closed Pro binary links, and no setting in 3.32.1 disables viewport rendering.
A few-line fix there is effective but cannot be applied to a Pro install, so
repairing the files is the only route that works with a stock Pro QCAD. The
proper long-term fix is an upstream bug report to RibbonSoft.

## License

Copyright (C) 2026 dhunt84971

GNU General Public License v3.0 — see [LICENSE](LICENSE).

These scripts run inside QCAD and use its GPL-licensed scripting API, so they
are released under the same license as QCAD community.
