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

    if (this.getMode()==="files") {
        this.repairFiles();
    }
    else {
        this.repairCurrentDrawing();
    }

    this.terminate();
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

    setOverrideWaitCursor();
    var res;
    try {
        // undoable: this is the user's own document, Edit > Undo must work
        res = RepairEngine.repairDocument(di, doc, true);
    }
    finally {
        restoreOverrideCursor();
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
    destr(progress);
    EAction.activateMainWindow();

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
    dlg.setOption(QFileDialog.DontUseNativeDialog, getDontUseNativeDialog());
    if (!isNull(QFileDialog.DontUseCustomDirectoryIcons)) {
        dlg.setOption(QFileDialog.DontUseCustomDirectoryIcons, true);
    }
    dlg.fileMode = QFileDialog.ExistingFiles;

    if (!dlg.exec()) {
        destrDialog(dlg);
        EAction.activateMainWindow();
        return undefined;
    }

    var files = dlg.selectedFiles();
    RSettings.setValue("RepairDrawings/InputPath", dlg.directory().absolutePath());
    destrDialog(dlg);
    EAction.activateMainWindow();

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
    new QDir(firstDir).mkpath(suggested);         // so it can be picked at once

    // getExistingDirectory() is unreliable with native dialogs, so use an
    // instance of QFileDialog in directory mode, as QCAD itself does.
    var dlg = new QFileDialog(appWin, qsTr("Folder for the Repaired Copies"), suggested, "");
    dlg.setOption(QFileDialog.DontUseNativeDialog, getDontUseNativeDialog());
    dlg.fileMode = QFileDialog.Directory;
    dlg.setOption(QFileDialog.ShowDirsOnly, true);
    dlg.setOption(QFileDialog.DontResolveSymlinks, true);
    if (!isNull(QFileDialog.DontUseCustomDirectoryIcons)) {
        dlg.setOption(QFileDialog.DontUseCustomDirectoryIcons, true);
    }

    if (!dlg.exec()) {
        destrDialog(dlg);
        EAction.activateMainWindow();
        return undefined;
    }

    var chosen = dlg.selectedFiles();
    destrDialog(dlg);
    EAction.activateMainWindow();

    if (chosen.length===0) {
        return undefined;
    }
    var outDir = chosen[0];

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
