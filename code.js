"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
figma.showUI(__html__, { width: 580, height: 520, title: 'Chat Bubble Zones' });
let previewDebounce = null;
let previewGeneration = 0;
/** Which selected bubble the UI is editing (kept while that node stays in the selection). */
let activeBubbleId = null;
/** Export source bubbles at higher density so the markup editor can zoom without pixelating immediately. */
const PREVIEW_EXPORT_SCALE = 4;
/** Must match `ZONE_STORAGE_PREFIX` in ui.html — zones are stored in figma.clientStorage (UI localStorage is unreliable). */
const ZONE_V1_PREFIX = 'chatBubbleZones:v1:';
function zoneStorageKeyMain(nodeId) {
    return ZONE_V1_PREFIX + nodeId;
}
function getExportableSelection() {
    const out = [];
    for (const n of figma.currentPage.selection) {
        if ('exportAsync' in n && 'width' in n && 'height' in n) {
            out.push(n);
        }
    }
    return out;
}
function sendPreviewFromSelection(gen) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const exportable = getExportableSelection();
        if (exportable.length === 0) {
            if (gen !== previewGeneration)
                return;
            activeBubbleId = null;
            const raw = figma.currentPage.selection.length;
            figma.ui.postMessage({
                type: 'needs-selection',
                message: raw === 0
                    ? 'Select one or more frames or layers to preview.'
                    : 'None of the selected nodes can be exported as PNG.',
            });
            return;
        }
        let peers = exportable.map((n) => ({
            id: n.id,
            name: n.name,
            width: Math.round(n.width),
            height: Math.round(n.height),
        }));
        /** Small PNG per bubble so the compare strip can show thumbnails (only when multi-select). */
        if (exportable.length > 1) {
            const thumbResults = yield Promise.all(exportable.map((n) => __awaiter(this, void 0, void 0, function* () {
                try {
                    const tb = yield n.exportAsync({
                        format: 'PNG',
                        constraint: { type: 'WIDTH', value: 48 },
                    });
                    return { id: n.id, bytes: Array.from(tb) };
                }
                catch (_a) {
                    return { id: n.id, bytes: [] };
                }
            })));
            if (gen !== previewGeneration)
                return;
            const thumbById = new Map(thumbResults.map((t) => [t.id, t.bytes]));
            peers = peers.map((p) => {
                var _a;
                return (Object.assign(Object.assign({}, p), { thumbBytes: (_a = thumbById.get(p.id)) !== null && _a !== void 0 ? _a : [] }));
            });
        }
        if (!activeBubbleId || !exportable.some((n) => n.id === activeBubbleId)) {
            activeBubbleId = exportable[0].id;
        }
        const node = (_a = exportable.find((n) => n.id === activeBubbleId)) !== null && _a !== void 0 ? _a : exportable[0];
        activeBubbleId = node.id;
        try {
            const bytes = yield node.exportAsync({
                format: 'PNG',
                constraint: { type: 'SCALE', value: PREVIEW_EXPORT_SCALE },
            });
            if (gen !== previewGeneration)
                return;
            const w = Math.round(node.width);
            const h = Math.round(node.height);
            let zoneSnapshot = null;
            try {
                const raw = yield figma.clientStorage.getAsync(zoneStorageKeyMain(node.id));
                zoneSnapshot = typeof raw === 'string' ? raw : null;
            }
            catch (_b) {
                zoneSnapshot = null;
            }
            figma.ui.postMessage({
                type: 'preview',
                bytes: Array.from(bytes),
                width: w,
                height: h,
                nodeId: node.id,
                selectionPeers: peers,
                zoneSnapshot,
            });
        }
        catch (e) {
            if (gen !== previewGeneration)
                return;
            figma.ui.postMessage({ type: 'error', message: 'Export failed: ' + String(e) });
        }
    });
}
function schedulePreviewRefresh() {
    if (previewDebounce !== null)
        clearTimeout(previewDebounce);
    const gen = ++previewGeneration;
    previewDebounce = setTimeout(() => {
        previewDebounce = null;
        void sendPreviewFromSelection(gen);
    }, 120);
}
figma.on('selectionchange', schedulePreviewRefresh);
figma.on('currentpagechange', schedulePreviewRefresh);
figma.ui.onmessage = (msg) => __awaiter(void 0, void 0, void 0, function* () {
    if (msg.type === 'ready') {
        schedulePreviewRefresh();
        return;
    }
    if (msg.type === 'pick-bubble') {
        const id = msg.nodeId;
        const exportable = getExportableSelection();
        if (exportable.some((n) => n.id === id)) {
            activeBubbleId = id;
            schedulePreviewRefresh();
        }
        return;
    }
    if (msg.type === 'persist-zones') {
        const nodeId = msg.nodeId != null && msg.nodeId !== '' ? String(msg.nodeId) : '';
        const json = msg.json;
        if (nodeId && typeof json === 'string' && json.length > 0) {
            try {
                yield figma.clientStorage.setAsync(zoneStorageKeyMain(nodeId), json);
            }
            catch (_a) {
                /* ignore */
            }
        }
        return;
    }
    // ── Annotated PNGs from UI (flex + content, no preview text) → two image rects ──
    if (msg.type === 'create-snapshots') {
        try {
            const flexBytes = new Uint8Array(msg.flexBytes);
            const contentBytes = new Uint8Array(msg.contentBytes);
            const width = msg.width;
            const height = msg.height;
            const imageFlex = figma.createImage(flexBytes);
            const imageContent = figma.createImage(contentBytes);
            const rectFlex = figma.createRectangle();
            rectFlex.name = 'Bubble — Stretch zone';
            rectFlex.resize(width, height);
            rectFlex.fills = [{ type: 'IMAGE', imageHash: imageFlex.hash, scaleMode: 'FILL' }];
            const rectContent = figma.createRectangle();
            rectContent.name = 'Bubble — Content zone';
            rectContent.resize(width, height);
            rectContent.fills = [{ type: 'IMAGE', imageHash: imageContent.hash, scaleMode: 'FILL' }];
            const exportable = getExportableSelection();
            const anchorNode = (activeBubbleId && exportable.find((n) => n.id === activeBubbleId)) || exportable[0];
            let x = figma.viewport.bounds.x + 20;
            let y = figma.viewport.bounds.y + 20;
            if (anchorNode && 'x' in anchorNode) {
                const orig = anchorNode;
                x = orig.x + orig.width + 40;
                y = orig.y;
            }
            const gap = 16;
            rectFlex.x = x;
            rectFlex.y = y;
            rectContent.x = x + width + gap;
            rectContent.y = y;
            figma.currentPage.appendChild(rectFlex);
            figma.currentPage.appendChild(rectContent);
            figma.viewport.scrollAndZoomIntoView([rectFlex, rectContent]);
            figma.ui.postMessage({ type: 'snapshot-done' });
        }
        catch (e) {
            figma.ui.postMessage({
                type: 'error',
                message: 'Could not create snapshots: ' + String(e),
            });
        }
        return;
    }
    if (msg.type === 'close') {
        figma.closePlugin();
    }
});
