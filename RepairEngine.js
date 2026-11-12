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
 * RepairEngine.js
 *
 * Shared detection and repair logic for badly formed DWG/DXF drawings.
 * Used by both front ends:
 *
 *   RepairSlowDrawing.js              command line (qcad -autostart)
 *   addon/RepairDrawings/*.js         menu item inside QCAD
 *
 * Nothing in here touches the user interface or the command line, so it can
 * run against the document the user has open as easily as against a document
 * imported in the background.
 *
 * Two defects are detected and removed:
 *
 *  1. RECURSIVE VIEWPORTS
 *     A VIEWPORT entity that lives inside a normal (non-layout) block. When
 *     that block is inserted into model space, rendering it renders the
 *     viewport, which renders model space, which renders the block again.
 *     QCAD has no cycle detection, only a depth limit of 16, so the whole
 *     drawing is rendered 16 times over on every repaint. A viewport inside a
 *     non-layout block has no meaning (AutoCAD does not draw it either), so
 *     it is removed. Viewports in real paper space layouts are left alone.
 *
 *  2. BLANK ATTRIBUTE ROWS
 *     Block references to blocks that carry no drawable geometry (only
 *     attribute definitions) and whose own attribute values are all empty.
 *     These are invisible but are fully processed on every import and every
 *     repaint. Typically the leftover rows of an empty BOM / parts list
 *     template.
 */

if (typeof(RepairEngine)==="undefined") {
    var RepairEngine = {};
}

RepairEngine.version = "1.0";

/**
 * A document suitable for importing a drawing into in the background.
 * Prefers QCAD's own spatial index factory when it is available (it is in the
 * GUI, where a plugin may have overridden the index class).
 */
RepairEngine.createDocument = function() {
    var si;
    if (typeof(createSpatialIndex)==="function") {
        si = createSpatialIndex();
    }
    else if (typeof(RSpatialIndexNavel)!=="undefined") {
        si = new RSpatialIndexNavel();
    }
    else {
        si = new RSpatialIndexSimple();
    }
    return new RDocument(new RMemoryStorage(), si);
};

/** entity count over all blocks, the figure the repair is measured in */
RepairEngine.countEntities = function(doc) {
    return doc.queryAllEntities(false, true).length;
};

/**
 * A block is an "attribute row template" if it holds at least one attribute
 * definition and nothing that can ever be drawn. Completely empty blocks are
 * NOT matched - they may be intentional markers.
 */
RepairEngine.isAttributeRowTemplate = function(doc, blockId) {
    var ids = doc.queryBlockEntities(blockId);
    var attDefs = 0;
    for (var i=0; i<ids.length; i++) {
        var e = doc.queryEntityDirect(ids[i]);
        if (isNull(e)) {
            continue;
        }
        if (e.getType()===RS.EntityAttributeDefinition) {
            attDefs++;
            continue;
        }
        return false;
    }
    return attDefs>0;
};

/**
 * True if every attribute of this block reference is empty.
 *
 * Read values with queryEntityDirect().getPlainText(): queryEntity() returns a
 * clone whose scripting wrapper exposes no text accessor at all, so a check
 * written against it silently sees every attribute as blank and would delete
 * rows that are filled in.
 */
RepairEngine.allAttributesBlank = function(doc, blockRefId) {
    var attIds = doc.queryChildEntities(blockRefId, RS.EntityAttribute);
    for (var i=0; i<attIds.length; i++) {
        var a = doc.queryEntityDirect(attIds[i]);
        if (isNull(a)) {
            continue;
        }
        if (!isFunction(a.getPlainText)) {
            // cannot read it, so cannot prove it is blank: keep the row
            return false;
        }
        var txt = a.getPlainText();
        if (!isNull(txt) && txt.trim().length>0) {
            return false;
        }
    }
    return true;
};

/** viewports that sit in a block which is not a paper space layout */
RepairEngine.findRecursiveViewports = function(doc) {
    var out = [];
    var ids = doc.queryAllEntities(false, true, RS.EntityViewport);
    for (var i=0; i<ids.length; i++) {
        var vp = doc.queryEntityDirect(ids[i]);
        if (isNull(vp)) {
            continue;
        }
        var blk = doc.queryBlock(vp.getBlockId());
        if (isNull(blk)) {
            continue;
        }
        if (blk.hasLayout()) {
            continue;                                  // legitimate layout viewport
        }
        if (vp.getBlockId()===doc.getModelSpaceBlockId()) {
            continue;
        }
        out.push({ id: ids[i], block: blk.getName() });
    }
    return out;
};

/**
 * Survey a document for both defects without changing anything.
 *
 * \return object with:
 *   viewports    array of { id, block } for each recursive viewport
 *   rows         ids of block references that are blank attribute rows
 *   rowsPerBlock block name -> number of blank rows referencing it
 *   blockIds     ids of block definitions all of whose references are blank
 *                (deleting the definition takes its references with it)
 *   blockNames   names of those block definitions
 */
RepairEngine.findDefects = function(doc) {
    var defects = {
        viewports: [],
        rows: [],
        rowsPerBlock: {},
        blockIds: [],
        blockNames: []
    };

    defects.viewports = RepairEngine.findRecursiveViewports(doc);

    // which blocks are attribute row templates:
    var blockIds = doc.queryAllBlocks();
    var isTemplate = {};
    var b;
    for (b=0; b<blockIds.length; b++) {
        isTemplate[blockIds[b]] = RepairEngine.isAttributeRowTemplate(doc, blockIds[b]);
    }

    // which references to those blocks are blank, and how many references
    // each block has in total:
    var refIds = doc.queryAllEntities(false, true, RS.EntityBlockRef);
    var refsPerBlock = {};
    var blankPerBlock = {};
    for (var r=0; r<refIds.length; r++) {
        var ref = doc.queryEntityDirect(refIds[r]);
        if (isNull(ref)) {
            continue;
        }
        var rb = ref.getReferencedBlockId();
        refsPerBlock[rb] = (refsPerBlock[rb] || 0) + 1;

        if (isTemplate[rb]!==true) {
            continue;
        }
        if (!RepairEngine.allAttributesBlank(doc, refIds[r])) {
            continue;
        }
        defects.rows.push(refIds[r]);
        blankPerBlock[rb] = (blankPerBlock[rb] || 0) + 1;

        var nm = doc.getBlockName(rb);
        defects.rowsPerBlock[nm] = (defects.rowsPerBlock[nm] || 0) + 1;
    }

    // a block whose every reference is a blank row can go as a whole:
    for (var bid in blankPerBlock) {
        if (blankPerBlock[bid]===refsPerBlock[bid]) {
            var id = parseInt(bid, 10);
            var blk = doc.queryBlock(id);
            if (!isNull(blk)) {
                defects.blockIds.push(id);
                defects.blockNames.push(blk.getName());
            }
        }
    }

    return defects;
};

RepairEngine.hasDefects = function(defects) {
    return defects.viewports.length>0 || defects.rows.length>0;
};

/** human readable lines describing what was found */
RepairEngine.describe = function(defects) {
    var lines = [];
    var i;
    for (i=0; i<defects.viewports.length; i++) {
        lines.push(qsTr("recursive viewport in block '%1'").arg(defects.viewports[i].block));
    }
    for (var nm in defects.rowsPerBlock) {
        lines.push(qsTr("blank attribute rows: block '%1' x%2")
                   .arg(nm).arg(defects.rowsPerBlock[nm]));
    }
    if (defects.blockNames.length>0) {
        lines.push(qsTr("block definition(s) no longer referenced: %1")
                   .arg(defects.blockNames.join(", ")));
    }
    return lines;
};

/**
 * Build the delete operation for everything in 'defects'.
 *
 * \param undoable true to make the deletion undoable - use this when working
 *        on the document the user has open. false is faster and is what the
 *        batch paths use on their throw-away documents.
 */
RepairEngine.createOperation = function(doc, defects, undoable) {
    if (isNull(undoable)) {
        undoable = false;
    }
    var op = new RDeleteObjectsOperation(undoable);
    if (isFunction(op.setText)) {
        // names the entry in QCAD's Edit > Undo menu
        op.setText(qsTr("Repair Drawing"));
    }
    var i;

    // whole block definitions first; their references go with them:
    var handled = {};
    for (i=0; i<defects.blockIds.length; i++) {
        var blk = doc.queryBlock(defects.blockIds[i]);
        if (!isNull(blk)) {
            op.deleteObject(blk);
            handled[defects.blockIds[i]] = true;
        }
    }

    // the remaining blank rows one at a time, each with its attributes:
    for (i=0; i<defects.rows.length; i++) {
        var e = doc.queryEntityDirect(defects.rows[i]);
        if (isNull(e)) {
            continue;
        }
        if (handled[e.getReferencedBlockId()]===true) {
            continue;
        }
        op.deleteObject(e);
        var attIds = doc.queryChildEntities(defects.rows[i], RS.EntityAttribute);
        for (var a=0; a<attIds.length; a++) {
            var at = doc.queryEntityDirect(attIds[a]);
            if (!isNull(at)) {
                op.deleteObject(at);
            }
        }
    }

    for (i=0; i<defects.viewports.length; i++) {
        var vpe = doc.queryEntityDirect(defects.viewports[i].id);
        if (!isNull(vpe)) {
            op.deleteObject(vpe);
        }
    }

    return op;
};

/**
 * Find and remove both defects in one call.
 *
 * \return object with:
 *   defects     the survey, as returned by findDefects()
 *   repaired    true if anything was deleted
 *   before      entity count before
 *   after       entity count after
 *   removed     entities removed
 *   blocks      block definitions removed
 *   viewports   recursive viewports removed
 *   rows        blank attribute rows found
 */
RepairEngine.repairDocument = function(di, doc, undoable) {
    var before = RepairEngine.countEntities(doc);
    var defects = RepairEngine.findDefects(doc);

    var res = {
        defects: defects,
        repaired: false,
        before: before,
        after: before,
        removed: 0,
        blocks: defects.blockIds.length,
        viewports: defects.viewports.length,
        rows: defects.rows.length
    };

    if (!RepairEngine.hasDefects(defects)) {
        res.blocks = 0;
        return res;
    }

    di.applyOperation(RepairEngine.createOperation(doc, defects, undoable));

    res.repaired = true;
    res.after = RepairEngine.countEntities(doc);
    res.removed = res.before - res.after;
    return res;
};
