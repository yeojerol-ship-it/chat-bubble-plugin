figma.showUI(__html__, { width: 580, height: 520, title: 'Chat Bubble Zones' });

let previewDebounce: ReturnType<typeof setTimeout> | null = null;
let previewGeneration = 0;
/** Which selected bubble the UI is editing (kept while that node stays in the selection). */
let activeBubbleId: string | null = null;

type ExportableNode = SceneNode & ExportMixin & LayoutMixin;

function getExportableSelection(): ExportableNode[] {
  const out: ExportableNode[] = [];
  for (const n of figma.currentPage.selection) {
    if ('exportAsync' in n && 'width' in n && 'height' in n) {
      out.push(n as ExportableNode);
    }
  }
  return out;
}

async function sendPreviewFromSelection(gen: number): Promise<void> {
  const exportable = getExportableSelection();

  if (exportable.length === 0) {
    if (gen !== previewGeneration) return;
    activeBubbleId = null;
    const raw = figma.currentPage.selection.length;
    figma.ui.postMessage({
      type: 'needs-selection',
      message:
        raw === 0
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
    const thumbResults = await Promise.all(
      exportable.map(async (n) => {
        try {
          const tb = await n.exportAsync({
            format: 'PNG',
            constraint: { type: 'WIDTH', value: 48 },
          });
          return { id: n.id, bytes: Array.from(tb) };
        } catch {
          return { id: n.id, bytes: [] as number[] };
        }
      }),
    );
    if (gen !== previewGeneration) return;
    const thumbById = new Map(thumbResults.map((t) => [t.id, t.bytes]));
    peers = peers.map((p) => ({
      ...p,
      thumbBytes: thumbById.get(p.id) ?? [],
    }));
  }

  if (!activeBubbleId || !exportable.some((n) => n.id === activeBubbleId)) {
    activeBubbleId = exportable[0].id;
  }

  const node = exportable.find((n) => n.id === activeBubbleId) ?? exportable[0];
  activeBubbleId = node.id;

  try {
    const bytes = await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'SCALE', value: 1 },
    });

    if (gen !== previewGeneration) return;

    const w = Math.round(node.width);
    const h = Math.round(node.height);

    figma.ui.postMessage({
      type: 'preview',
      bytes: Array.from(bytes),
      width: w,
      height: h,
      nodeId: node.id,
      selectionPeers: peers,
    });
  } catch (e) {
    if (gen !== previewGeneration) return;
    figma.ui.postMessage({ type: 'error', message: 'Export failed: ' + String(e) });
  }
}

function schedulePreviewRefresh(): void {
  if (previewDebounce !== null) clearTimeout(previewDebounce);
  const gen = ++previewGeneration;
  previewDebounce = setTimeout(() => {
    previewDebounce = null;
    void sendPreviewFromSelection(gen);
  }, 120);
}

figma.on('selectionchange', schedulePreviewRefresh);
figma.on('currentpagechange', schedulePreviewRefresh);

figma.ui.onmessage = async (msg: { type: string; [key: string]: unknown }) => {
  if (msg.type === 'ready') {
    schedulePreviewRefresh();
    return;
  }

  if (msg.type === 'pick-bubble') {
    const id = msg.nodeId as string;
    const exportable = getExportableSelection();
    if (exportable.some((n) => n.id === id)) {
      activeBubbleId = id;
      schedulePreviewRefresh();
    }
    return;
  }

  // ── Annotated PNG from UI → image node on canvas ────────────────────────
  if (msg.type === 'create-snapshot') {
    try {
      const bytes = new Uint8Array(msg.bytes as number[]);
      const width = msg.width as number;
      const height = msg.height as number;

      const image = figma.createImage(bytes);
      const rect = figma.createRectangle();
      rect.name = 'Bubble Zone Snapshot';
      rect.resize(width, height);
      rect.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];

      const exportable = getExportableSelection();
      const anchorNode =
        (activeBubbleId && exportable.find((n) => n.id === activeBubbleId)) || exportable[0];

      if (anchorNode && 'x' in anchorNode) {
        const orig = anchorNode as LayoutMixin & SceneNode;
        rect.x = orig.x + orig.width + 40;
        rect.y = orig.y;
      } else {
        rect.x = figma.viewport.bounds.x + 20;
        rect.y = figma.viewport.bounds.y + 20;
      }

      figma.currentPage.appendChild(rect);
      figma.viewport.scrollAndZoomIntoView([rect]);

      figma.ui.postMessage({ type: 'snapshot-done' });
    } catch (e) {
      figma.ui.postMessage({
        type: 'error',
        message: 'Could not create snapshot: ' + String(e),
      });
    }
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
