import type { LengthOptions, LengthPlan } from './length-planner';
import type { Scene } from './route-host';
import type { Box, Route, SelectionScope } from './routes';
import { touchesBox } from './routes';
import type { Progress } from './work';
import { assertConnectionsSteps } from './connectivity';
import { assertDocument } from './host';
import { measureGroups, planLengthsSteps, selectTargets } from './length-planner';
import { readScene } from './route-host';
import { replaceLayout } from './transaction';
import { runCooperatively } from './work';
import { assert45Changes } from './routing-direction';

export type LayerChoice = number | 'auto';
export interface LengthSelection { scene: Scene; chosen: Route[]; scope: SelectionScope; layer: number; layerChoice?: LayerChoice }
export function choose(scene: Scene, layerChoice: LayerChoice, scope: SelectionScope, box?: Box): LengthSelection {
	let layer: number;
	if (layerChoice === 'auto') {
		const selected = new Set(scene.selectedIds), available = new Set(scene.layers.map(l => l.id));
		const layers = [...new Set(scene.lines.filter(l => available.has(l.layer) && (box ? touchesBox(l.start, l.end, box, l.width / 2) : selected.has(l.id))).map(l => l.layer))];
		if (!layers.length) throw new Error('未找到可识别铜层的直线走线，请选择走线或调整取区');
		layer = layers.length === 1 ? layers[0] : 0;
	} else {
		if (!scene.layers.some(l => l.id === layerChoice)) throw new Error('请选择有效铜层');
		layer = layerChoice;
	}
	const chosen = selectTargets(scene.routes, scene.lines, layer, scope, scene.selectedIds, box, scene.obstacles, scene.vias);
	const usedLayers = new Set(chosen.flatMap(r => r.lines.map(l => l.layer)));
	return { scene, chosen, scope, layer: usedLayers.size === 1 ? [...usedLayers][0] : 0, layerChoice };
}
export function fingerprint(scene: Scene) {
	return JSON.stringify({ doc: [scene.doc.uuid, scene.doc.parentProjectUuid], lines: scene.lines, arcs: scene.arcs, vias: scene.vias, boundaries: scene.boundaries, obstacles: [...scene.obstacles].sort((a, b) => a.id.localeCompare(b.id)), layers: scene.layers, boundaryError: scene.boundaryError });
}
async function freshSelection(snapshot: LengthSelection) {
	await assertDocument(snapshot.scene.doc);
	const scene = await readScene(undefined, false);
	await assertDocument(snapshot.scene.doc);
	if (fingerprint(scene) !== fingerprint(snapshot.scene)) throw new Error('PCB 走线、障碍或图层已变化，请重新读取并预览');
	const ids = snapshot.chosen.flatMap(r => r.lines.map(l => l.id)).sort();
	if (JSON.stringify([...scene.selectedIds].sort()) !== JSON.stringify(ids)) throw new Error('画布选中集已变化，请重新读取');
	return scene;
}
export async function previewLengths(snapshot: LengthSelection, options: LengthOptions, progress?: Progress): Promise<LengthPlan> {
	try {
		const scene = await freshSelection(snapshot);
		if (scene.boundaryError) throw new Error(scene.boundaryError);
		const plan = await runCooperatively(planLengthsSteps(scene.lines, snapshot.chosen, options, scene.obstacles, scene.boundaries), progress);
		await progress?.('正在核对原有连接…');
		await runCooperatively(assertConnectionsSteps(scene.lines, plan.lines, scene.obstacles));
		await assertDocument(scene.doc);
		return plan;
	}
	catch (error) { console.error('[TrackEqualLength]', 'Preview failed', error); throw error; }
}
export async function applyLengths(snapshot: LengthSelection, plan: LengthPlan, progress?: Progress) {
	try {
		const scene = await freshSelection(snapshot);
		assert45Changes(scene.lines, plan.lines);
		await runCooperatively(assertConnectionsSteps(scene.lines, plan.lines, scene.obstacles));
		const verify = (actual: typeof scene.lines) => {
			const lengths = measureGroups(plan, actual);
			if (lengths.some(n => Math.abs(n - plan.target) > plan.options.tolerance + 0.001)) throw new Error('宿主实际长度超出目标容差');
		};
		const before = scene.lines.concat(scene.arcs ?? []), target = plan.lines.concat(scene.arcs ?? []);
		const result = await replaceLayout(scene.doc, before, target, scene.obstacles, before, progress, verify);
		return { changed: plan.changed, pushed: plan.pushed, lengths: measureGroups(plan, result.actual), modified: result.modified, added: result.added };
	}
	catch (error) { console.error('[TrackEqualLength]', 'Apply failed', error); throw error; }
}
