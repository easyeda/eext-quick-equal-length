export {};
const COMMAND = 'track-length-command-v1';
const STATE = 'track-length-state-v1';
import { copperBounds } from './copper';
const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => byId<HTMLInputElement>(id);
const select = (id: string) => byId<HTMLSelectElement>(id);
const fields = ['amplitude', 'minAmplitude', 'pitch', 'clearance', 'tolerance', 'target'];
let busy = false, picking = false, valid = false, ready = false, polling = false;
let pending = '', serial = 0, layerList = '', lastRevision = 0;
type TargetGroup = { name: string; nets: string[] };
let savedGroups: { equalLength: TargetGroup[]; netClass: TargetGroup[] } = { equalLength: [], netClass: [] };
const groupChoice: Record<string, string> = {};
function renderGroups() {
	const kind = select('groupKind').value as keyof typeof savedGroups, groups = savedGroups[kind], label = kind === 'netClass' ? '网络类' : '等长组';
	select('targetGroup').replaceChildren(new Option(groups.length ? `选择已有${label}` : `暂无${label}`, ''), ...groups.map(g => new Option(`${g.name}（${g.nets.length}网）`, g.name)));
	if (groups.some(g => g.name === groupChoice[kind])) select('targetGroup').value = groupChoice[kind];
	select('targetGroup').title = groups.find(g => g.name === select('targetGroup').value)?.nets.join('、') ?? '读取后加入累计目标';
}
let previousFactor = 1;
let dirty = false;
let rawRows: { net: string; before: number; after: number; added: number; styles?: string[] }[] = [];
const styleNames: Record<string, string> = { single: '单边', double: '双边', large: '大折返' };
let themePolling = false;
async function syncTheme() {
	if (themePolling) return;
	themePolling = true;
	try {
		const theme = await eda.sys_Window?.getCurrentTheme?.();
		if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
	}
	catch { /* Keep the last EDA theme; before the first successful read CSS follows the system. */ }
	finally { themePolling = false; }
}
void syncTheme();
setInterval(() => { if (!document.hidden) void syncTheme(); }, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncTheme(); });
document.body.dataset.started = 'true';
const factor = () => select('unit').value === 'mm' ? 1 / 0.0254 : 1;
function status(text: string, error = false) { byId('status').textContent = text; byId('status').classList.toggle('error', error); }
function controls() {
	for (const id of [...fields, 'unit', 'scope', 'layer', 'targetMode', 'side', 'mode', 'pattern', 'lobes', 'dynamicAmplitude', 'differential']) byId<HTMLInputElement>(id).disabled = busy || picking;
	input('target').disabled ||= select('targetMode').value !== 'manual';
	input('lobes').disabled ||= ['large', 'mixed'].includes(select('pattern').value);
	input('minAmplitude').disabled ||= select('pattern').value === 'large';
	select('side').title = select('pattern').value === 'double' ? '双边交替展开，此处决定首波方向' : '沿原线段起点到终点定义左右侧';
	byId<HTMLButtonElement>('read').disabled = busy || picking;
	byId<HTMLButtonElement>('clear').disabled = busy || picking;
	select('targetGroup').disabled = busy || picking;
	select('groupKind').disabled = busy || picking;
	byId<HTMLButtonElement>('refreshGroups').disabled = busy || picking;
	byId<HTMLButtonElement>('readGroup').disabled = busy || picking || !select('targetGroup').value;
	byId<HTMLButtonElement>('pick').disabled = busy;
	byId('pick').textContent = picking ? '取消取区' : '两点取区';
	byId<HTMLButtonElement>('previewButton').disabled = busy || picking || !valid;
	byId<HTMLButtonElement>('apply').disabled = busy || picking || !ready;
	byId('hint').textContent = select('pattern').value === 'large' ? '大折返优先少量宽幅绕线 · 最小振幅 H 不适用。' : `W 为折返臂中心距，H 为单侧最小振幅 · ${select('pattern').value === 'double' ? '双边峰谷直接相连' : '单边连续'} · 波数0为自动。`;
	if (select('pattern').value === 'mixed') byId('hint').textContent = '自动组合三种形式 · 波数自动 · H约束圆角；悬停网络名查看样式。';
	if (input('differential').checked) byId('hint').textContent = '两条线为一对，可跨过孔；在同层平行段补长。优先补偿小长度差，必要时共同蛇形/折返。';
}
function options() {
	return { differential: input('differential').checked, dynamicAmplitude: input('dynamicAmplitude').checked, target: select('targetMode').value === 'longest' ? 'longest' : input('target').valueAsNumber * factor(), amplitude: input('amplitude').valueAsNumber * factor(), minAmplitude: select('pattern').value === 'large' ? 0 : input('minAmplitude').valueAsNumber * factor(), pitch: input('pitch').valueAsNumber * factor(), clearance: input('clearance').valueAsNumber * factor(), tolerance: input('tolerance').valueAsNumber * factor(), side: select('side').value, mode: select('mode').value, pattern: select('pattern').value, lobes: ['large', 'mixed'].includes(select('pattern').value) ? 0 : input('lobes').valueAsNumber };
}
async function send(action: string) {
	if (busy) return;
	const config = options();
	if (['preview', 'apply'].includes(action) && (!Number.isFinite(config.minAmplitude) || config.minAmplitude < 0 || config.minAmplitude > config.amplitude)) { status('最小振幅 H 须大于等于 0，且不得超过最大振幅', true); return; }
	if (['preview', 'apply'].includes(action) && config.pattern !== 'large' && (!Number.isInteger(config.lobes) || config.lobes < 0 || config.lobes > 48)) { status('波数须为0至48的整数，0表示自动', true); return; }
	if (['preview', 'apply'].includes(action) && config.pattern === 'double' && config.lobes === 1) { status('双边蛇形至少需要2波（每侧至少1波）；也可设0自动', true); return; }
	if (['preview', 'apply'].includes(action) && (![config.amplitude, config.pitch, config.tolerance].every(n => Number.isFinite(n) && n > 0) || !Number.isFinite(config.clearance) || config.clearance < 0 || (config.target !== 'longest' && (!Number.isFinite(config.target) || Number(config.target) <= 0)))) { status('请输入有效长度，幅度/间距/容差须大于 0，净距不得为负', true); return; }
	try {
		if (['preview', 'read', 'readGroup'].includes(action)) dirty = false;
		busy = true; controls(); pending = `${Date.now()}-${serial++}`;
		status(action === 'pick' ? '请依次单击画布矩形的两角' : '正在处理…');
		if (!await eda.sys_Storage.setExtensionUserConfig(COMMAND, { id: pending, action, groupKind: select('groupKind').value, targetGroup: select('targetGroup').value, scope: select('scope').value, layer: select('layer').value === 'auto' ? 'auto' : Number(select('layer').value), options: config })) throw new Error('无法发送命令');
	}
	catch (error) { console.error('[TrackEqualLength]', 'Send failed', error); pending = ''; busy = false; status(String(error), true); controls(); }
}
function renderRows() {
	const tbody = byId('rows');
	tbody.replaceChildren();
	if (!rawRows.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 4; td.className = 'empty'; td.textContent = '读取后显示各目标长度'; tr.append(td); tbody.append(tr); }
	for (let i = 0; i < rawRows.length; i++) {
		const row = rawRows[i]; const tr = document.createElement('tr');
		if (row.styles?.length) tr.title = `采用样式：${row.styles.map(s => styleNames[s] || s).join(' + ')}`;
		for (const text of [`${i + 1}. ${row.net}`, ...[row.before, row.after, row.added].map(n => (n / factor()).toFixed(select('unit').value === 'mm' ? 4 : 3))]) { const td = document.createElement('td'); td.textContent = text; td.title = tr.title ? `${text} — ${tr.title}` : text; tr.append(td); }
		tbody.append(tr);
	}
}
function renderPreview(targets: number[][][], pushed: number[][][] = []) {
	const groups = [...targets, ...pushed];
	const svg = byId<SVGElement & HTMLElement>('preview');
	svg.replaceChildren();
	const points = groups.flat().flatMap(l => {
		const box = copperBounds({ id: '', net: '', layer: 1, width: 0, locked: false, start: { x: l[0], y: l[1] }, end: { x: l[2], y: l[3] }, arcAngle: l[4] });
		return [[box.minX, box.minY], [box.maxX, box.maxY]];
	});
	if (!points.length) { const text = document.createElementNS('http://www.w3.org/2000/svg', 'text'); text.setAttribute('x', '185'); text.setAttribute('y', '52'); text.setAttribute('text-anchor', 'middle'); text.textContent = '预览方案后显示路径（示意，不含周围障碍）'; svg.append(text); return; }
	const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
	const minX = Math.min(...xs), maxY = Math.max(...ys);
	const scale = Math.min(346 / (Math.max(...xs) - minX || 1), 76 / (maxY - Math.min(...ys) || 1));
	groups.forEach((group, i) => group.forEach(l => {
		const line = document.createElementNS('http://www.w3.org/2000/svg', l[4] ? 'path' : 'line');
		const x1 = 12 + (l[0] - minX) * scale, y1 = 10 + (maxY - l[1]) * scale, x2 = 12 + (l[2] - minX) * scale, y2 = 10 + (maxY - l[3]) * scale;
		if (l[4]) {
			const r = Math.hypot(l[2] - l[0], l[3] - l[1]) * scale / (2 * Math.sin(Math.abs(l[4]) * Math.PI / 360));
			line.setAttribute('d', `M${x1},${y1} A${r},${r} 0 ${Math.abs(l[4]) > 180 ? 1 : 0},${l[4] > 0 ? 0 : 1} ${x2},${y2}`); line.setAttribute('fill', 'none');
		} else for (const [k, value] of Object.entries({ x1, y1, x2, y2 })) line.setAttribute(k, String(value));
		line.setAttribute('stroke', i >= targets.length ? 'var(--pushed)' : `var(--trace-${i % 4})`);
		if (i >= targets.length) line.setAttribute('stroke-dasharray', '3 2');
		svg.append(line);
	}));
}
async function poll() {
	if (polling) return;
	polling = true;
	try {
		const state = await eda.sys_Storage.getExtensionUserConfig(STATE);
		if (!state || (pending && state.ack !== pending) || state.revision === lastRevision) return;
		lastRevision = state.revision; pending = ''; busy = !!state.busy; picking = !!state.picking; valid = !!state.valid; ready = !!state.previewReady && !dirty;
		byId('count').textContent = `${Number(state.count) || 0} 个目标 · ${select('unit').value}`;
		status(state.message || '请选择走线', !!state.error);
		const nextGroups = { equalLength: state.equalLengthGroups ?? [], netClass: state.netClasses ?? [] };
		if (JSON.stringify(nextGroups) !== JSON.stringify(savedGroups)) { savedGroups = nextGroups; renderGroups(); }
		if (Array.isArray(state.layers) && JSON.stringify(state.layers) !== layerList) {
			layerList = JSON.stringify(state.layers); const old = select('layer').value;
			select('layer').replaceChildren(new Option('自动识别', 'auto'), ...state.layers.map((l: { id: number; name: string }) => new Option(l.name, String(l.id))));
			if (old === 'auto' || state.layers.some((l: { id: number }) => String(l.id) === old)) select('layer').value = old;
		}
		const detected = state.valid ? state.layers?.filter((l: { id: number }) => (state.resolvedLayers ?? [state.resolvedLayer]).includes(l.id)) : [];
		select('layer').options[0].text = detected?.length > 1 ? `自动 · ${detected.length}层` : detected?.length ? `自动 · ${detected[0].name}` : '自动识别';
		select('layer').title = detected?.length && select('layer').value === 'auto' ? `自动识别铜层：${detected.map((l: { name: string }) => l.name).join(' / ')}` : '按走线自动识别，可同时处理不同铜层；完整路径沿过孔连接';
		rawRows = state.rows || []; renderRows(); renderPreview(state.preview || [], state.pushedPreview || []); controls();
	}
	catch (error) { console.error('[TrackEqualLength]', 'Poll failed', error); status(`控制器读取失败：${String(error)}`, true); }
	finally { polling = false; }
}
byId('read').onclick = () => void send('read');
byId('refreshGroups').onclick = () => void send('refreshGroups');
byId('readGroup').onclick = () => void send('readGroup');
select('targetGroup').onchange = () => { groupChoice[select('groupKind').value] = select('targetGroup').value; renderGroups(); controls(); };
select('groupKind').onchange = () => { renderGroups(); controls(); };
byId('clear').onclick = () => { valid = false; ready = false; void send('clear'); };
byId('pick').onclick = () => void send(picking ? 'cancel' : 'pick');
byId('previewButton').onclick = () => void send('preview');
byId('apply').onclick = () => void send('apply');
for (const id of ['scope', 'layer']) byId(id).onchange = () => { valid = false; ready = false; controls(); void send('selection'); };
function markDirty() { dirty = true; ready = false; controls(); status('参数已改变，请重新预览'); }
for (const id of [...fields, 'lobes']) byId(id).oninput = markDirty;
for (const id of ['targetMode', 'side', 'mode', 'pattern', 'dynamicAmplitude', 'differential']) byId(id).onchange = markDirty;
select('unit').onchange = () => {
	for (const id of fields) if (Number.isFinite(input(id).valueAsNumber)) input(id).value = String(Number((input(id).valueAsNumber * previousFactor / factor()).toFixed(8)));
	previousFactor = factor(); renderRows(); byId('count').textContent = `${rawRows.length} 个目标 · ${select('unit').value}`; markDirty();
};
controls(); void poll(); setInterval(() => { void poll(); }, 200);

