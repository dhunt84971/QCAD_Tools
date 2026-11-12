/*
 * Copyright (C) 2026 dhunt84971
 *
 * This file is part of QCAD Tools.
 *
 * QCAD Tools is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option) any later
 * version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with
 * this program. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * RepairSlowDrawing.js
 *
 * Command line front end for RepairEngine.js: repairs DWG/DXF drawings that
 * take minutes to open and redraw in QCAD because of two defects, a viewport
 * inside a non-layout block (unbounded render recursion) and large numbers of
 * blank attribute rows. See RepairEngine.js for the detail of both.
 *
 * Usage, from the QCAD installation directory:
 *
 *   ./qcad -no-dock-icon -allow-multiple-instances -platform offscreen \
 *          -autostart /path/to/RepairSlowDrawing.js -- \
 *          [-n] [-k] [-o OUTDIR] FILE [FILE ...]
 *
 *     -n          dry run: report what would be removed, write nothing
 *     -o OUTDIR   write repaired files to OUTDIR
 *                 (default: next to the input, "-repaired" appended)
 *     -k          keep the original file name instead of appending
 *                 "-repaired" (requires -o pointing somewhere else)
 *
 * Paths must be absolute: QCAD's launcher calls QDir::setCurrent() during
 * startup, so a relative path no longer resolves by the time this runs.
 *
 * Output keeps the format of the input (DWG stays DWG, DXF stays DXF).
 *
 * Every file also produces one machine-readable line for scripts to parse:
 *
 *     RESULT<TAB>repaired|clean|dryrun|error<TAB>removed<TAB>blocks<TAB>viewports<TAB>in<TAB>out
 */

include("RepairEngine.js");

function parseArgs() {
    var all = QCoreApplication.arguments();
    var opts = { dryRun: false, outDir: undefined, keepName: false, files: [] };
    var i = all.indexOf("--");
    var args = (i === -1) ? [] : all.slice(i + 1);
    for (var k = 0; k < args.length; k++) {
        var a = args[k];
        if (a === "-n") { opts.dryRun = true; }
        else if (a === "-k") { opts.keepName = true; }
        else if (a === "-o") { opts.outDir = args[++k]; }
        else if (a.startsWith("-")) { /* ignore */ }
        else { opts.files.push(a); }
    }
    return opts;
}

/** one tab-separated line per file, for scripts */
function result(status, removed, blocks, viewports, inFile, outFile) {
    print("RESULT\t" + status + "\t" + removed + "\t" + blocks + "\t"
          + viewports + "\t" + inFile + "\t" + (isNull(outFile) ? "-" : outFile));
}

function repair(file, opts) {
    var doc = RepairEngine.createDocument();
    var di = new RDocumentInterface(doc);
    di.setNotifyListeners(false);

    var res = di.importFile(file);
    if (res !== RDocumentInterface.IoErrorNoError) {
        print("ERROR: cannot import " + file + " (code " + res + ")");
        result("error", 0, 0, 0, file, undefined);
        di.destroy();
        return false;
    }

    var before = RepairEngine.countEntities(doc);
    print("");
    print("file: " + file);
    print("  entities (all blocks) before: " + before);

    var defects = RepairEngine.findDefects(doc);
    var lines = RepairEngine.describe(defects);
    for (var i = 0; i < lines.length; i++) {
        print("  " + lines[i]);
    }

    if (!RepairEngine.hasDefects(defects)) {
        print("  nothing to repair");
        result("clean", 0, 0, 0, file, undefined);
        di.destroy();
        return true;
    }
    if (opts.dryRun) {
        result("dryrun", defects.rows.length, defects.blockIds.length,
               defects.viewports.length, file, undefined);
        di.destroy();
        return true;
    }

    di.applyOperation(RepairEngine.createOperation(doc, defects, false));

    var after = RepairEngine.countEntities(doc);
    var removedBlocks = defects.blockIds.length;
    print("  entities (all blocks) after:  " + after);
    print("  removed: " + (before - after) + " entities, "
          + removedBlocks + " block definition(s), "
          + defects.viewports.length + " recursive viewport(s)");

    var fi = new QFileInfo(file);
    var base = opts.keepName
        ? fi.fileName()
        : fi.completeBaseName() + "-repaired." + fi.suffix();
    var outDir = isNull(opts.outDir) ? fi.absolutePath() : opts.outDir;
    var outFile = outDir + "/" + base;

    if (new QFileInfo(outFile).canonicalFilePath() === fi.canonicalFilePath()) {
        print("  ERROR: output would overwrite the input: " + outFile);
        result("error", before - after, removedBlocks, defects.viewports.length,
               file, undefined);
        di.destroy();
        return false;
    }

    var dir = new QDir(outDir);
    if (!dir.exists() && !dir.mkpath(".")) {
        print("  ERROR: cannot create output directory: " + outDir);
        result("error", before - after, removedBlocks, defects.viewports.length,
               file, undefined);
        di.destroy();
        return false;
    }

    var ok = di.exportFile(outFile, "");
    if (!ok) {
        print("  ERROR: could not write " + outFile);
        print("  ERROR: nothing was saved for " + file);
        result("error", before - after, removedBlocks, defects.viewports.length,
               file, undefined);
    } else {
        print("  written: " + outFile);
        result("repaired", before - after, removedBlocks, defects.viewports.length,
               file, outFile);
    }
    di.destroy();
    return ok;
}

function main() {
    var opts = parseArgs();
    if (opts.files.length === 0) {
        print("usage: ... -autostart RepairSlowDrawing.js -- [-n] [-k] [-o OUTDIR] FILE [FILE ...]");
        return;
    }
    var failed = 0;
    for (var i = 0; i < opts.files.length; i++) {
        if (!repair(opts.files[i], opts)) {
            failed++;
        }
    }
    print("");
    if (failed > 0) {
        print("FAILED: " + failed + " of " + opts.files.length + " file(s) were not repaired");
    } else {
        print("OK: " + opts.files.length + " file(s)");
    }
    print("");
}

main();
