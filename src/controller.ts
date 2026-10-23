import type { Point } from './geometry';
import type { LengthOptions, LengthPlan } from './length-planner';
import type { LengthSelection, LayerChoice } from './length-host';
import type { SelectionScope } from './routes';
import { assertDocument } from './host';
import { applyLengths, choose, previewLengths } from './length-host';
import { routeLength } from './length-planner';
import { readScene } from './route-host';

export const COMMAND_KEY = 'track-length-command-v1';
export const STATE_KEY = 'track-length-state-v1';
const TIMER = 'track-length-controller';
const LISTENER = 'track-length-picker';
let snapshot: LengthSelection | undefined;
let plan: LengthPlan | undefined;
let busy = false;
let captureBusy = false;
let lastCommand = '';
let picking: { doc: IDMT_EditorDocumentItem; layer: LayerChoice; scope: SelectionScope; first?: Point; deadline: number } | undefined;
let view: Record<string, unknown> = {};
let alive = false;
let accumulatedIds = new Set<string>();
let accumulatedScope: SelectionScope | undefined;
let accumulatedDoc: string | undefined;

async function publish(message?: string, extra: Record<string, unknown> = {}) {
	try {
		view = { ...view, ...extra, ...(message === undefined ? {} : { message }) };
		const rows = plan?.rows ?? snapshot?.chosen.map(r => ({ id: r.id, net: r.net, before: routeLength(r), after: routeLength(r), added: 0, error: 0 }));
		if (!await eda.sys_Storage.setExtensionUserConfig(STATE_KEY, { ...view, resolvedLayer: snapshot?.layer, resolvedLayers: snapshot ? [...new Set(snapshot.chosen.flatMap(r => r.lines.map(l => l.layer)))] : [], busy: busy || captureBusy, picking: !!picking, valid: !!snapshot, previewReady: !!plan, count: snapshot?.chosen.length ?? 0, rows: rows ?? [], preview: plan?.groups.slice(0, 16).map(group => group.slice(0, 512).map(l => [l.start.x, l.start.y, l.end.x, l.end.y, l.arcAngle ?? 0])), pushedPreview: plan?.pushedPreview.slice(0, 16).map(group => group.slice(0, 512).map(l => [l.start.x, l.start.y, l.end.x, l.end.y, l.arcAngle ?? 0])), pushed: plan?.pushed, target: plan?.target, ack: lastCommand, revision: Date.now() })) throw new Error('无法发布面板状态');
	}
	catch (error) { console.error('[TrackEqualLength]', 'Publish failed', error); }
}
async function stopPicking() {
	try { picking = undefined; eda.pcb_Event.removeEventListener(LISTENER); }
	catch (error) { console.error('[TrackEqualLength]', 'Remove picker failed', error); }
}
type GroupKind = 'equalLength' | 'netClass';
async function readGroups(kind: GroupKind) {
	const doc = await assertDocument();
	const groups = (await (kind === 'netClass' ? eda.pcb_Drc.getAllNetClasses() : eda.pcb_Drc.getAllEqualLengthNetGroups())).map(c => ({ name: c.name, nets: [...new Set(c.nets)] }));
	await assertDocument(doc);
	return groups;
}
async function refreshGroups() {
	const doc = await assertDocument();
	const results = await Promise.allSettled([readGroups('equalLength'), readGroups('netClass')]);
	await assertDocument(doc);
	const warning = results.flatMap((r, i) => r.status === 'rejected' ? [`${i ? '网络类' : '等长组'}读取失败：${String(r.reason)}`] : []);
	await publish(warning.length ? warning.join('；') : '等长组和网络类列表已刷新', {
		equalLengthGroups: results[0].status === 'fulfilled' ? results[0].value : [],
		netClasses: results[1].status === 'fulfilled' ? results[1].value : [], error: !!warning.length,
	});
}
async function read(layer: LayerChoice, scope: SelectionScope, box?: { minX: number; minY: number; maxX: number; maxY: number }, expected?: IDMT_EditorDocumentItem, groupName?: string, kind: GroupKind = 'equalLength') {
	snapshot = undefined; plan = undefined;
	const doc = await assertDocument(expected);
	const groups = groupName === undefined ? undefined : await readGroups(kind);
	const group = groups?.find(c => c.name === groupName), label = kind === 'netClass' ? '网络类' : '等长组';
	if (groupName !== undefined && !group) throw new Error(`${label}已不存在，请刷新列表`);
	const scene = await readScene();
	await assertDocument(doc);
	if (group && !group.nets.length) throw new Error(`${label} ${groupName} 没有成员网络`);
	const seeds = group ? scene.lines.filter(l => group.nets.includes(l.net)).map(l => l.id) : scene.selectedIds;
	if (group && !seeds.length) throw new Error(`${label} ${groupName} 在当前 PCB 中没有可用直线走线`);
	const added = choose({ ...scene, selectedIds: seeds }, layer, scope, box);
	if (accumulatedScope !== scope || accumulatedDoc !== scene.doc.uuid) { accumulatedIds.clear(); accumulatedScope = scope; accumulatedDoc = scene.doc.uuid; }
	const ids = new Set([...accumulatedIds, ...added.chosen.flatMap(r => r.lines.map(l => l.id))]);
	const result = choose({ ...scene, selectedIds: [...ids] }, 'auto', scope);
	result.layerChoice = layer;
	if (!await eda.pcb_SelectControl.clearSelected() || !await eda.pcb_SelectControl.doSelectPrimitives(result.chosen.flatMap(r => r.lines.map(l => l.id)))) throw new Error('画布选中失败，请重读');
	await assertDocument(scene.doc);
	snapshot = result;
	accumulatedIds = new Set(result.chosen.flatMap(r => r.lines.map(l => l.id)));
	const names = [...new Set(result.chosen.flatMap(r => r.lines.map(l => l.layer)))].map(id => scene.layers.find(l => l.id === id)?.name ?? String(id));
	await publish(`${group ? `${label} ${groupName}；` : ''}已识别 ${names.join(' / ')}；累计 ${result.chosen.length} 个${scope === 'route' ? '完整走线' : '线段'}，请预览等长方案`, { error: false, layers: scene.layers, ...(groups ? { [kind === 'netClass' ? 'netClasses' : 'equalLengthGroups']: groups } : {}) });
}
export function pickerEvent(type: string) { return type === 'selected' || type === 'clearSelected'; }
async function beginPicking(layer: LayerChoice, scope: SelectionScope) {
	await stopPicking(); snapshot = undefined; plan = undefined;
	picking = { doc: await assertDocument(), layer, scope, deadline: Date.now() + 30000 };
	try {
		eda.pcb_Event.addMouseEventListener(LISTENER, 'all', async (type) => {
			if (!picking || captureBusy || busy || !pickerEvent(type)) return;
			captureBusy = true;
			try {
				const target = picking;
				await assertDocument(target.doc);
				const point = await eda.pcb_SelectControl.getCurrentMousePosition();
				if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
				if (!target.first) { target.first = { ...point }; await publish('已取第一角，请单击第二角'); return; }
				if (Math.abs(point.x - target.first.x) < 10 || Math.abs(point.y - target.first.y) < 10) { await publish('矩形宽高须至少 10mil，请重新点击第二角'); return; }
				const box = { minX: Math.min(point.x, target.first.x), maxX: Math.max(point.x, target.first.x), minY: Math.min(point.y, target.first.y), maxY: Math.max(point.y, target.first.y) };
				await stopPicking(); busy = true;
				await publish('正在读取区域内走线…');
				await read(target.layer, target.scope, box, target.doc);
			}
			catch (error) { console.error('[TrackEqualLength]', 'Picker failed', error); await stopPicking(); snapshot = undefined; plan = undefined; await publish(String(error), { error: true }); }
			finally { captureBusy = false; busy = false; await publish(); }
		});
		await publish('请依次单击画布矩形的两个角（30秒内）', { error: false });
	}
	catch (error) { await stopPicking(); console.error('[TrackEqualLength]', 'Start picker failed', error); throw error; }
}
export async function tick() {
	if (!alive || busy || captureBusy) return;
	let handled = false;
	try {
		if (picking && Date.now() > picking.deadline) { await stopPicking(); await publish('取区超时，请重试', { error: true }); }
		const command = eda.sys_Storage.getExtensionUserConfig(COMMAND_KEY);
		if (!command || !command.id || command.id === lastCommand) return;
		lastCommand = command.id; busy = true; handled = true;
		const scope: SelectionScope = command.scope === 'segment' ? 'segment' : 'route';
		const layer: LayerChoice = command.layer === 'auto' ? 'auto' : Number(command.layer);
		await publish('正在处理…', { error: false });
		if (command.action === 'pick') await beginPicking(layer, scope);
		else if (command.action === 'clear') {
			await stopPicking(); snapshot = undefined; plan = undefined; accumulatedIds.clear(); accumulatedScope = scope;
			if (!await eda.pcb_SelectControl.clearSelected()) throw new Error('无法清空画布选中集');
			await publish('目标已清空，可重新选择走线并累积读取');
		}
		else if (command.action === 'cancel' || command.action === 'selection') {
			if (accumulatedScope !== scope) { accumulatedIds.clear(); accumulatedScope = scope; }
			await stopPicking(); snapshot = undefined; plan = undefined;
			await publish('请选择走线后读取，或两点取区');
		}
		else if (command.action === 'invalidate') { plan = undefined; await publish('参数已改变，请重新预览'); }
		else if (command.action === 'read') { await stopPicking(); await read(layer, scope); }
		else if (command.action === 'refreshGroups') {
			await refreshGroups();
		}
		else if (command.action === 'readGroup') {
			if (typeof command.targetGroup !== 'string' || !command.targetGroup) throw new Error('请先选择已有等长组或网络类');
			await stopPicking(); await read(layer, scope, undefined, undefined, command.targetGroup, command.groupKind === 'netClass' ? 'netClass' : 'equalLength');
		}
		else if (command.action === 'preview' || command.action === 'apply') {
			if (!snapshot || (snapshot.layerChoice ?? snapshot.layer) !== layer || snapshot.scope !== scope) throw new Error('选择范围或铜层已改变，请重新读取');
			if (picking) throw new Error('请先完成或取消取区');
			const options = command.options as LengthOptions;
			if (!options || typeof options !== 'object') throw new Error('缺少等长参数');
			if (command.action === 'preview') {
				plan = undefined;
				plan = await previewLengths(snapshot, options, message => publish(message));
				await publish(plan.changed ? `${plan.originalTarget !== undefined ? `45°重排后目标 ${plan.target.toFixed(3)}mil（原最长 ${plan.originalTarget.toFixed(3)}mil）；` : ''}方案可行：补长 ${plan.changed} 个目标；推挤 ${plan.pushed.length} 条${plan.pushed.length ? `（${[...new Set(plan.pushed.map(r => r.net))].join('、')}）` : ''}，可应用` : '所有目标已在容差内，无需补长');
			}
			else {
				if (!plan || JSON.stringify(plan.options) !== JSON.stringify(options)) throw new Error('参数已改变，请重新预览后应用');
				const result = await applyLengths(snapshot, plan, message => publish(message));
				const target = plan.target;
				snapshot = undefined; plan = undefined;
				accumulatedIds.clear();
				await publish(`完成：补长 ${result.changed} 个目标、推挤 ${result.pushed.length} 条，目标 ${target.toFixed(3)}mil；实际最大误差 ${Math.max(...result.lengths.map(n => Math.abs(n - target))).toFixed(4)}mil。再次操作请重新读取`, { result });
			}
		}
		else throw new Error('未知命令');
	}
	catch (error) { console.error('[TrackEqualLength]', 'Command failed', error); plan = undefined; await publish(String(error), { error: true }); }
	finally { if (handled) { busy = false; await publish(); } }
}
export async function startController() {
	try {
		if (busy || captureBusy) throw new Error('正在处理，请稍候');
		await stopPicking(); snapshot = undefined; plan = undefined; accumulatedIds.clear(); accumulatedScope = undefined; accumulatedDoc = undefined; lastCommand = ''; view = {}; alive = true;
		await eda.sys_Storage.setExtensionUserConfig(COMMAND_KEY, undefined);
		const layers = (await eda.pcb_Layer.getAllLayers()).filter(l => l.type === 'SIGNAL' && l.layerStatus !== 0).map(l => ({ id: l.id, name: l.name }));
		await publish('选择走线后读取，或两点取区；铜层默认自动识别', { error: false, layers });
		await refreshGroups();
		if (!eda.sys_Timer.setIntervalTimer(TIMER, 200, () => { void tick(); })) throw new Error('无法启动控制器');
	}
	catch (error) { alive = false; console.error('[TrackEqualLength]', 'Start controller failed', error); throw error; }
}
export async function closeController() {
	try { if (busy || captureBusy) return false; alive = false; await stopPicking(); eda.sys_Timer.clearIntervalTimer(TIMER); return true; }
	catch (error) { console.error('[TrackEqualLength]', 'Close controller failed', error); return false; }
}
