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
 * RepairDrawings.js
 *
 * QCAD add-on: repairs badly formed DWG/DXF drawings from inside the
 * application. Two menu entries share this file (see RepairDrawingsInit.js):
 *
 *   Repair Current Drawing   works on the drawing that is open. Instant,
 *                            undoable, leaves the file on disk untouched
 *                            until you save.
 *   Repair Drawing Files...  pick any number of drawings, repaired copies
 *                            are written to a folder you choose. The
 *                            originals are never modified.
 *
 * The detection and deletion logic lives in RepairEngine.js, shared with the
 * command line front end.
 */

include("scripts/EAction.js");
include("RepairEngine.js");

function RepairDrawings(guiAction) {
    EAction.call(this, guiAction);
}

RepairDrawings.prototype = new EAction();
RepairDrawings.includeBasePath = includeBasePath;

RepairDrawings.prototype.beginEvent = function() {
    EAction.prototype.beginEvent.call(this);

    // Any error inside a script action is swallowed by QCAD and only reaches
    // the terminal, so an unattended failure looks exactly like the tool doing
    // nothing. Report it where it can actually be seen.
    try {
        if (this.getMode()==="files") {
            this.repairFiles();
        }
        else {
            this.repairCurrentDrawing();
        }
    }
    catch (e) {
        RepairDrawings.reportException(e);
    }

    this.terminate();
};

RepairDrawings.reportException = function(e) {
    var msg = "" + e;
    if (!isNull(e) && !isNull(e.lineNumber)) {
        msg += "\n(" + qsTr("line") + " " + e.lineNumber + ")";
    }
    qWarning("RepairDrawings: " + msg);
    EAction.handleUserWarning(qsTr("Repair Drawings failed: %1").arg(msg));

    var appWin = EAction.getMainWindow();
    if (!isNull(appWin)) {
        QMessageBox.critical(appWin, qsTr("Repair Drawings"),
            qsTr("The repair stopped because of an unexpected error:\n\n%1").arg(msg));
        appWin.activateWindow();
    }
};

/**
 * Which of the two actions was triggered. Falls back to a sensible choice if
 * the action cannot be identified: with a drawing open, repair it; without
 * one, there is nothing to do but pick files.
 */
RepairDrawings.prototype.getMode = function() {
    var name = "";
    if (!isNull(this.guiAction) && !isNull(this.guiAction.objectName)) {
        name = this.guiAction.objectName;
    }
    if (name.indexOf("Files")!==-1) {
        return "files";
    }
    if (name.indexOf("Current")!==-1) {
        return "current";
    }
    return isNull(this.getDocument()) ? "files" : "current";
};

// -----------------------------------------------------------------------
// repair the open drawing
// -----------------------------------------------------------------------

RepairDrawings.prototype.repairCurrentDrawing = function() {
    var appWin = EAction.getMainWindow();
    var doc = this.getDocument();
    var di = this.getDocumentInterface();

    if (isNull(doc) || isNull(di)) {
        EAction.handleUserWarning(qsTr("No drawing is open."));
        return;
    }

    RepairDrawings.waitCursor(true);
    var res;
    try {
        // undoable: this is the user's own document, Edit > Undo must work
        res = RepairEngine.repairDocument(di, doc, true);
    }
    finally {
        RepairDrawings.waitCursor(false);
    }

    var lines = RepairEngine.describe(res.defects);
    for (var i=0; i<lines.length; i++) {
        EAction.handleUserMessage(lines[i]);
    }

    if (!res.repaired) {
        EAction.handleUserMessage(qsTr("Nothing to repair in this drawing."));
        QMessageBox.information(appWin, qsTr("Repair Drawing"),
                                qsTr("Nothing to repair in this drawing."));
        appWin.activateWindow();
        return;
    }

    di.regenerateScenes();
    di.repaintViews();

    var msg = qsTr("Removed %1 entities, %2 block definition(s) and %3 recursive viewport(s).")
              .arg(res.removed).arg(res.blocks).arg(res.viewports);
    EAction.handleUserMessage(msg);
    QMessageBox.information(appWin, qsTr("Repair Drawing"),
                            msg + "\n\n"
                            + qsTr("The drawing on disk is unchanged until you save it. "
                                   + "Edit > Undo reverses the repair."));
    appWin.activateWindow();
};

// -----------------------------------------------------------------------
// repair files on disk
// -----------------------------------------------------------------------

RepairDrawings.prototype.repairFiles = function() {
    var appWin = EAction.getMainWindow();

    var files = RepairDrawings.chooseInputFiles(appWin);
    if (isNull(files) || files.length===0) {
        return;
    }

    // a breadcrumb in the command line history, so a failure between the two
    // dialogs is visible as something other than silence:
    EAction.handleUserMessage(
        qsTr("%1 drawing(s) selected, now choose a folder for the repaired copies")
        .arg(files.length));

    // Copies keep their original names, so two drawings with the same name
    // from different folders would overwrite each other in the output.
    var clash = RepairDrawings.duplicateNames(files);
    if (clash.length>0) {
        QMessageBox.critical(appWin, qsTr("Repair Drawings"),
            qsTr("The repaired copies keep their original file names, so these "
                 + "names cannot be repaired together:\n\n%1\n\n"
                 + "Repair them one folder at a time.").arg(clash.join("\n")));
        appWin.activateWindow();
        return;
    }

    var outDir = RepairDrawings.chooseOutputFolder(appWin, files);
    if (isNull(outDir)) {
        return;
    }

    var rows = [];
    var canceled = false;

    var progress = new QProgressDialog(qsTr("Repairing drawings..."),
                                       qsTr("Cancel"), 0, files.length, appWin);
    progress.windowModality = Qt.WindowModal;
    progress.setMinimumDuration(0);
    progress.value = 0;

    for (var i=0; i<files.length; i++) {
        var name = new QFileInfo(files[i]).fileName();

        // Importing a damaged drawing takes tens of seconds and blocks the
        // GUI thread, so show which file is being worked on before starting
        // it rather than after.
        progress.setLabelText(qsTr("Repairing %1 of %2:\n%3")
                              .arg(i + 1).arg(files.length).arg(name));
        progress.value = i;
        QCoreApplication.processEvents();

        if (RepairDrawings.wasCanceled(progress)) {
            canceled = true;
            break;
        }

        rows.push(this.repairFile(files[i], outDir));
    }

    progress.value = files.length;
    progress.close();
    RepairDrawings.closeDialog(progress);

    RepairDrawings.report(appWin, rows, outDir, canceled);
};

/**
 * Repair one file into outDir, under its original name.
 * \return a row for the summary: { file, status, removed, viewports, note }
 */
RepairDrawings.prototype.repairFile = function(file, outDir) {
    var fi = new QFileInfo(file);
    var row = {
        file: fi.fileName(),
        status: "error",
        removed: 0,
        viewports: 0,
        note: ""
    };

    var doc = RepairEngine.createDocument();
    var di = new RDocumentInterface(doc);
    di.setNotifyListeners(false);

    try {
        if (di.importFile(file)!==RDocumentInterface.IoErrorNoError) {
            row.note = qsTr("QCAD cannot read this file");
            return row;
        }

        var res = RepairEngine.repairDocument(di, doc, false);
        var outFile = outDir + QDir.separator + fi.fileName();

        if (!res.repaired) {
            // copy it through, so the output folder is a complete set:
            if (RepairDrawings.copyFile(file, outFile)) {
                row.status = "clean";
                row.note = qsTr("nothing to repair; copied through");
            }
            else {
                row.note = qsTr("nothing to repair, but the copy failed");
            }
            return row;
        }

        if (!di.exportFile(outFile, "")) {
            row.note = qsTr("repaired, but could not be written");
            return row;
        }

        row.status = "repaired";
        row.removed = res.removed;
        row.viewports = res.viewports;
        return row;
    }
    finally {
        di.destroy();
    }
};

// -----------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------

// -----------------------------------------------------------------------
// QCAD library helpers, called defensively
//
// QCAD's own script library differs between releases: a helper that exists in
// one version is missing in another, and calling a missing one raises a
// ReferenceError that aborts the whole action. Everything below goes through a
// wrapper that falls back to whatever the running QCAD actually provides, so
// the add-on works across versions instead of dying on one.
// -----------------------------------------------------------------------

/** close and dispose of a dialog, then put the focus back on the main window */
RepairDrawings.closeDialog = function(dlg) {
    if (!isNull(dlg)) {
        if (typeof(destrDialog)==="function") {
            destrDialog(dlg);
        }
        else if (typeof(destr)==="function") {
            destr(dlg);
        }
        else if (isFunction(dlg.close)) {
            dlg.close();
        }
    }
    RepairDrawings.activateMainWindow();
};

RepairDrawings.activateMainWindow = function() {
    if (isFunction(EAction.activateMainWindow)) {
        EAction.activateMainWindow();
        return;
    }
    var appWin = EAction.getMainWindow();
    if (!isNull(appWin) && isFunction(appWin.activateWindow)) {
        appWin.activateWindow();
    }
};

/** true when QCAD is configured to avoid the desktop's native file dialogs */
RepairDrawings.dontUseNativeDialog = function() {
    if (typeof(getDontUseNativeDialog)==="function") {
        return getDontUseNativeDialog();
    }
    // When in doubt use Qt's own dialog: it behaves the same everywhere.
    return true;
};

RepairDrawings.waitCursor = function(on) {
    if (on===true) {
        if (typeof(setOverrideWaitCursor)==="function") { setOverrideWaitCursor(); }
    }
    else {
        if (typeof(restoreOverrideCursor)==="function") { restoreOverrideCursor(); }
    }
};

RepairDrawings.chooseInputFiles = function(appWin) {
    var lastDir = RSettings.getStringValue("RepairDrawings/InputPath",
                                           RSettings.getDocumentsLocation());

    var filters = [ qsTr("Drawings") + " (*.dwg *.dxf)",
                    qsTr("DWG Files") + " (*.dwg)",
                    qsTr("DXF Files") + " (*.dxf)",
                    qsTr("All Files") + " (*)" ];

    var dlg = new QFileDialog(appWin, qsTr("Choose Drawings to Repair"), lastDir, "");
    dlg.setNameFilters(filters);
    dlg.selectNameFilter(filters[0]);
    dlg.setOption(QFileDialog.DontUseNativeDialog, RepairDrawings.dontUseNativeDialog());
    if (!isNull(QFileDialog.DontUseCustomDirectoryIcons)) {
        dlg.setOption(QFileDialog.DontUseCustomDirectoryIcons, true);
    }
    dlg.fileMode = QFileDialog.ExistingFiles;

    if (!dlg.exec()) {
        RepairDrawings.closeDialog(dlg);
        return undefined;
    }

    var files = dlg.selectedFiles();
    RSettings.setValue("RepairDrawings/InputPath", dlg.directory().absolutePath());
    RepairDrawings.closeDialog(dlg);

    return files;
};

/**
 * Ask for the folder the repaired copies go into, defaulting to
 * "<folder of the first drawing>-repaired", and refuse a folder that any of
 * the chosen drawings lives in: the originals are never overwritten.
 */
RepairDrawings.chooseOutputFolder = function(appWin, files) {
    var firstDir = new QFileInfo(files[0]).absolutePath();
    var suggested = firstDir + "-repaired";

    // Create the suggestion up front so it can be accepted with one click.
    // If creating it fails - a read-only parent folder, a network share - fall
    // back to the folder the drawings came from: a file dialog opened on a
    // directory that does not exist can silently refuse to appear.
    if (!new QDir(suggested).exists()) {
        new QDir(firstDir).mkpath(suggested);
    }
    var startDir = new QDir(suggested).exists() ? suggested : firstDir;

    var dlg = new QFileDialog(appWin, qsTr("Folder for the Repaired Copies"), startDir, "");

    // Always Qt's own dialog here, never the desktop's native one. A native
    // directory chooser is unreliable across desktops - QCAD's own code says
    // the same about getExistingDirectory() - and when it fails it fails by
    // never appearing, which looks like the tool doing nothing at all.
    dlg.setOption(QFileDialog.DontUseNativeDialog, true);
    dlg.fileMode = QFileDialog.Directory;
    if (!isNull(QFileDialog.ShowDirsOnly)) {
        dlg.setOption(QFileDialog.ShowDirsOnly, true);
    }
    if (!isNull(QFileDialog.DontResolveSymlinks)) {
        dlg.setOption(QFileDialog.DontResolveSymlinks, true);
    }
    if (!isNull(QFileDialog.DontUseCustomDirectoryIcons)) {
        dlg.setOption(QFileDialog.DontUseCustomDirectoryIcons, true);
    }
    // Fill the "Directory:" box with the suggestion. Without this the box is
    // empty and the Choose button does nothing until something is typed or
    // picked, which reads as another dead end.
    if (isFunction(dlg.selectFile)) {
        dlg.selectFile(startDir);
    }

    if (!dlg.exec()) {
        RepairDrawings.closeDialog(dlg);
        return undefined;
    }

    var chosen = dlg.selectedFiles();
    RepairDrawings.closeDialog(dlg);

    if (chosen.length===0) {
        return undefined;
    }
    var outDir = chosen[0];

    // the folder may have been typed rather than picked:
    if (!new QDir(outDir).exists() && !new QDir(outDir).mkpath(".")) {
        QMessageBox.critical(appWin, qsTr("Repair Drawings"),
            qsTr("This folder does not exist and could not be created:\n\n%1").arg(outDir));
        appWin.activateWindow();
        return undefined;
    }

    var outCanonical = new QFileInfo(outDir).canonicalFilePath();
    for (var i=0; i<files.length; i++) {
        var srcDir = new QFileInfo(new QFileInfo(files[i]).absolutePath()).canonicalFilePath();
        if (srcDir===outCanonical) {
            QMessageBox.critical(appWin, qsTr("Repair Drawings"),
                qsTr("The folder for the repaired copies cannot be a folder that "
                     + "holds one of the chosen drawings, because the originals "
                     + "must not be overwritten.\n\nNothing was changed."));
            appWin.activateWindow();
            return undefined;
        }
    }

    return outDir;
};

/** file names that occur more than once in the selection */
RepairDrawings.duplicateNames = function(files) {
    var seen = {};
    var dupes = [];
    for (var i=0; i<files.length; i++) {
        var name = new QFileInfo(files[i]).fileName();
        if (seen[name]===true) {
            if (dupes.indexOf(name)===-1) {
                dupes.push(name);
            }
        }
        seen[name] = true;
    }
    return dupes;
};

RepairDrawings.copyFile = function(from, to) {
    var dst = new QFile(to);
    if (dst.exists() && !dst.remove()) {
        return false;
    }
    return new QFile(from).copy(to);
};

/** wasCanceled is a method in some bindings and a property in others */
RepairDrawings.wasCanceled = function(progress) {
    if (isFunction(progress.wasCanceled)) {
        return progress.wasCanceled()===true;
    }
    if (!isNull(progress.wasCanceled)) {
        return progress.wasCanceled===true;
    }
    return false;
};

RepairDrawings.report = function(appWin, rows, outDir, canceled) {
    var repaired = 0;
    var clean = 0;
    var failed = 0;
    var removed = 0;
    var detail = [];

    for (var i=0; i<rows.length; i++) {
        var r = rows[i];
        switch (r.status) {
        case "repaired":
            repaired++;
            removed += r.removed;
            detail.push("%1: %2".arg(r.file)
                        .arg(qsTr("repaired, %1 entities removed").arg(r.removed)));
            break;
        case "clean":
            clean++;
            detail.push("%1: %2".arg(r.file).arg(r.note));
            break;
        default:
            failed++;
            detail.push("%1: %2".arg(r.file).arg(r.note));
            break;
        }
    }

    for (var d=0; d<detail.length; d++) {
        EAction.handleUserMessage(detail[d]);
    }

    var text = qsTr("Repaired: %1\nAlready clean: %2\nFailed: %3")
               .arg(repaired).arg(clean).arg(failed);
    if (removed>0) {
        text += "\n" + qsTr("%1 dead entities removed in total.").arg(removed);
    }
    if (canceled) {
        text += "\n\n" + qsTr("Canceled: the remaining drawings were not processed.");
    }
    if (repaired>0 || clean>0) {
        text += "\n\n" + qsTr("The copies are in:\n%1").arg(outDir);
    }
    if (failed>0) {
        text += "\n\n" + qsTr("Drawings that failed were not copied. Details are in "
                              + "the command line history.");
    }

    EAction.handleUserMessage(qsTr("Repair finished: %1 repaired, %2 clean, %3 failed")
                              .arg(repaired).arg(clean).arg(failed));

    if (failed>0) {
        QMessageBox.warning(appWin, qsTr("Repair Drawings"), text);
    }
    else {
        QMessageBox.information(appWin, qsTr("Repair Drawings"), text);
    }
    appWin.activateWindow();
};
