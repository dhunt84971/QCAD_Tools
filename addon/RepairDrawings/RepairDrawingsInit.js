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
 * Registers the two Repair Drawings menu entries. Both run RepairDrawings.js,
 * which tells them apart by objectName.
 *
 * They are placed in the menu, toolbar and tool panel of QCAD's "Misc > IO"
 * group, next to the other file-processing tools.
 */
function init(basePath) {
    var appWin = RMainWindowQt.getMainWindow();

    // --- repair the drawing that is open -----------------------------------
    var current = new RGuiAction(qsTranslate("RepairDrawings", "Repair &Current Drawing"),
                                 appWin);
    current.objectName = "RepairDrawingsCurrentAction";
    current.setRequiresDocument(true);
    current.setScriptFile(basePath + "/RepairDrawings.js");
    current.setIcon(basePath + "/RepairDrawings.svg");
    current.setStatusTip(qsTranslate("RepairDrawings",
        "Remove recursive viewports and blank attribute rows from the open drawing"));
    current.setDefaultCommands(["repaircurrent", "repairdrawing"]);
    current.setNoState();
    current.setGroupSortOrder(52100);
    current.setSortOrder(600);
    current.setWidgetNames(["MiscIOMenu", "MiscIOToolBar", "MiscIOToolsPanel"]);

    // --- repair files on disk ---------------------------------------------
    var files = new RGuiAction(qsTranslate("RepairDrawings", "Repair Drawing &Files..."),
                               appWin);
    files.objectName = "RepairDrawingsFilesAction";
    // no document needed: this one works entirely on files
    files.setRequiresDocument(false);
    files.setScriptFile(basePath + "/RepairDrawings.js");
    files.setIcon(basePath + "/RepairDrawingsFiles.svg");
    files.setStatusTip(qsTranslate("RepairDrawings",
        "Write repaired copies of the chosen drawings to another folder"));
    files.setDefaultCommands(["repairfiles"]);
    files.setNoState();
    files.setGroupSortOrder(52100);
    files.setSortOrder(610);
    files.setWidgetNames(["MiscIOMenu", "MiscIOToolBar", "MiscIOToolsPanel"]);
}
