import type { Line } from './geometry';
import type { Obstacle, Route } from './routes';
import type { Progress } from './work';
import { assertDocument, lineData, arcData } from './host';
import { buildRoutesSteps, outlinePoints } from './routes';
import { runCooperatively, yieldEditor } from './work';
import { resolveArcPrecision } from './native-arcs';
import type { ViaLink } from './cross-layer';

const TAG = '[TrackLength]';
export interface Scene {
	doc: IDMT_EditorDocumentItem;
	lines: Line[];
	arcs?: Line[];
	boundaries: Line[];
	obstacles: Obstacle[];
	routes: Route[];
	layers: { id: number; name: string }[];
	selectedIds: string[];
	vias?: ViaLink[];
	boundaryError?: string;
}

export async function readScene(progress?: Progress, withRoutes = true): Promise<Scene> {
	try {
		const doc = await assertDocument();
		const layers = (await eda.pcb_Layer.getAllLayers()).filter(l => l.type === 'SIGNAL' && l.layerStatus !== 0).map(l => ({ id: l.id, name: l.name }));
		const signals = new Set<number>(layers.map(l => l.id));
		const rawLines = await eda.pcb_PrimitiveLine.getAll();
		const allLines = rawLines.map(lineData).sort((a, b) => a.id.localeCompare(b.id));
		const lines = allLines.filter(l => signals.has(l.layer));
		// EPCB_LayerId.BOARD_OUTLINE = 11, MULTI = 12 (verified official enum values).
		const boundaries = allLines.filter(l => l.layer === 11);
		let boundaryError: string | undefined;
		const polylines = await eda.pcb_PrimitivePolyline.getAll();
		for (const polyline of polylines.filter(p => p.getState_Layer() === 11)) {
			try {
				const points = outlinePoints(polyline.getState_Polygon().getSource());
				for (let i = 0; i < points.length; i++) {
					boundaries.push({ id: `${polyline.getState_PrimitiveId()}/${i}`, net: '', layer: 11, width: 0, locked: true, start: points[i], end: points[(i + 1) % points.length] });
				}
			}
			catch (error) {
				console.error(TAG, 'Unsupported board outline', error);
				boundaryError = String(error);
			}
		}
		const pads = await eda.pcb_PrimitivePad.getAll();
		const components = await eda.pcb_PrimitiveComponent.getAll();
		const componentPads: IPCB_PrimitiveComponentPad[] = [];
		for (let i = 0; i < components.length; i += 12) {
			const groups = await Promise.all(components.slice(i, i + 12).map(c => c.getAllPins()));
			componentPads.push(...groups.flat());
			await yieldEditor();
		}
		const vias = await eda.pcb_PrimitiveVia.getAll();
		const viaLinks: ViaLink[] = [];
		for (let i = 0; i < vias.length; i += 12) {
			viaLinks.push(...await Promise.all(vias.slice(i, i + 12).map(async v => ({ id: v.getState_PrimitiveId(), net: v.getState_Net(), point: { x: v.getState_X(), y: v.getState_Y() }, adjacentIds: (await v.getAdjacentPrimitives()).map(p => p.getState_PrimitiveId()).sort() }))));
			await yieldEditor();
		}
		const arcs = await eda.pcb_PrimitiveArc.getAll();
		const fills = await eda.pcb_PrimitiveFill.getAll();
		const keepouts = (await eda.pcb_PrimitiveRegion.getAll()).filter(p => p.getState_RuleType().includes(5));
		const descriptors = [
			...[...pads, ...componentPads].map(p => ({ id: p.getState_PrimitiveId(), net: p.getState_Net() ?? '', layer: p.getState_Layer(), terminal: true, pad: true })),
			...vias.map(p => ({ id: p.getState_PrimitiveId(), net: p.getState_Net(), layer: 12, terminal: true })),
			...arcs.map(p => ({ id: p.getState_PrimitiveId(), net: p.getState_Net(), layer: p.getState_Layer(), terminal: false })),
			...fills.map(p => ({ id: p.getState_PrimitiveId(), net: p.getState_Net() ?? '', layer: p.getState_Layer(), terminal: false })),
			// EPCB_PrimitiveRegionRuleType.NO_WIRES = 5. Keepout boxes block every net.
			...keepouts.map(p => ({ id: p.getState_PrimitiveId(), net: '', layer: p.getState_Layer(), terminal: false })),
			...polylines.filter(p => signals.has(p.getState_Layer())).map(p => ({ id: p.getState_PrimitiveId(), net: p.getState_Net(), layer: p.getState_Layer(), terminal: true, arc: true })),
		].filter(p => signals.has(p.layer) || p.layer === 12 || p.layer === 11);
		const obstacles: Obstacle[] = [];
		for (let i = 0; i < descriptors.length; i += 16) {
			const group = await Promise.all(descriptors.slice(i, i + 16).map(async (p) => {
				const box = await eda.pcb_Primitive.getPrimitivesBBox([p.id]);
				if (!box || !Object.values(box).every(Number.isFinite))
					throw new Error(`无法读取障碍 ${p.id} 的边界，已停止`);
				return { ...p, layer: p.layer === 11 ? 12 : p.layer, box };
			}));
			obstacles.push(...group);
			await yieldEditor();
		}
		for (const arc of arcs) {
			for (const point of [{ x: arc.getState_StartX(), y: arc.getState_StartY() }, { x: arc.getState_EndX(), y: arc.getState_EndY() }]) {
				obstacles.push({ id: `${arc.getState_PrimitiveId()}/end`, net: arc.getState_Net(), layer: arc.getState_Layer(), terminal: true, arc: true, box: { minX: point.x - 0.001, minY: point.y - 0.001, maxX: point.x + 0.001, maxY: point.y + 0.001 } });
			}
		}
		const selectedIds = await eda.pcb_SelectControl.getAllSelectedPrimitives_PrimitiveId();
		await assertDocument(doc);
		const routes = withRoutes ? await runCooperatively(buildRoutesSteps(lines, obstacles), progress) : [];
		const nativeArcs = await resolveArcPrecision(doc, arcs.map(arcData).filter(l => signals.has(l.layer)), [], new Map(obstacles.map(o => [o.id, o.box])));
		return { doc, lines, arcs: nativeArcs.sort((a, b) => a.id.localeCompare(b.id)), boundaries, obstacles, routes, layers, selectedIds, vias: viaLinks.sort((a, b) => a.id.localeCompare(b.id)), boundaryError };
	}
	catch (error) {
		console.error(TAG, 'Read routing scene failed', error);
		throw error;
	}
}

