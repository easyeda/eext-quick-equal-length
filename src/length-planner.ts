import type { Line, Point } from './geometry';
import type { Box, Obstacle, Route, SelectionScope } from './routes';
import type { Steps } from './work';
import type { PushedRoute } from './length-push';
import { shoveLengthsSteps } from './length-push';
import { fitMixedSteps } from './mixed';
import { fitAdaptiveLineSteps } from './adaptive';
import { includeTerminalStubs } from './terminal-stubs';
import { copperBounds, copperBoxDistance, copperDistance, copperInterval, copperLength } from './copper';
import { SpatialIndex } from './spatial';
import { materialize, planSegmentRoute } from './push-routes';
import { bundleLengthsSteps } from './bundle-length';
import { createSpacePriority } from './space-priority';
import type { WindowPriority } from './space-priority';
import { differentialPair, pairCoupled, pairedMeanderSteps, differentialSlideSteps } from './differential';
import type { PlanningPolicy } from './differential';
import { sameLineGeometry } from './geometry';
import { buildRoutesSteps, dist, pointDistance, touchesBox } from './routes';
import { finish } from './work';
import { assert45Changes } from './routing-direction';
import { crossLayerRoutes } from './cross-layer';
import type { ViaLink } from './cross-layer';
import { createPadPriority, PAD_PRIORITY, padEndOffsets } from './pad-priority';
import type { PadOptions } from './pad-priority';
import type { WaveOptions } from './serpentine';
import { continuous, roundedCandidates, waveCounts, waveExtraAt, waveMetrics } from './serpentine';

const EPS = 0.001;
const K = 2 * (Math.SQRT2 - 1);
export type TuningPattern = 'single' | 'double' | 'large';
export interface LengthSection { sourceId: string; pattern: TuningPattern; added: number; start: Point; end: Point; amplitudes?: number[] }
export interface LengthOptions {
	target: number | 'longest';
	amplitude: number;
	minAmplitude?: number;
	dynamicAmplitude?: boolean;
	differential?: boolean;
	pitch: number;
	clearance: number;
	tolerance: number;
	side: 'auto' | 'left' | 'right';
	mode?: 'direct' | 'push';
	pattern?: TuningPattern | 'mixed';
	lobes?: number;
}
export interface LengthRow { id: string; net: string; before: number; after: number; added: number; error: number; segments: number; styles?: TuningPattern[] }
export interface LengthPlan { lines: Line[]; target: number; originalTarget?: number; rows: LengthRow[]; groups: Line[][]; changed: number; options: LengthOptions; pushed: PushedRoute[]; pushedPreview: Line[][]; sections?: LengthSection[] }
export const lineLength = copperLength;
export const routeLength = (route: Route) => route.lines.reduce((sum, line) => sum + lineLength(line), 0);

export function selectTargets(routes: Route[], lines: Line[], layer: number, scope: SelectionScope, ids: string[], box?: Box, anchors: Obstacle[] = [], vias: ViaLink[] = []): Route[] {
	const set = new Set(ids);
	const hit = (l: Line) => (layer === 0 || l.layer === layer) && (box ? touchesBox(l.start, l.end, box, l.width / 2) : set.has(l.id));
	const chosen = scope === 'route' ? crossLayerRoutes(includeTerminalStubs(routes, anchors), vias).filter(r => r.lines.some(hit)) : lines.filter(hit).map(l => ({
		id: `segment/${l.id}`, net: l.net, layer: l.layer, lines: [l], points: [l.start, l.end], fixedStart: true, fixedEnd: true, locked: l.locked, unsupported: false,
	}));
	if (!chosen.length) throw new Error('没有命中所选铜层的直线走线，请重新选择');
	if (chosen.some(r => r.locked)) throw new Error('目标含锁定线段，请先解锁');
	if (chosen.some(r => r.unsupported)) throw new Error('完整走线含闭环、圆弧接入或中部 T 连接，请改选独立线段');
	if (chosen.some(r => !r.net)) throw new Error('目标含无网络线段，无法可靠识别走线');
	if (chosen.flatMap(r => r.lines).some(l => ![l.start.x, l.start.y, l.end.x, l.end.y, l.width].every(Number.isFinite) || l.width <= 0 || lineLength(l) <= EPS)) throw new Error('目标含无效坐标、线宽或零长度线段');
	if (chosen.length > 64) throw new Error('一次最多处理 64 个等长目标，请缩小选择范围');
	return chosen;
}

function validate(chosen: Route[], options: LengthOptions) {
	if (!chosen.length) throw new Error('请先读取目标');
	for (const key of ['amplitude', 'pitch', 'tolerance'] as const) {
		if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error('最大幅度、蛇形间距和长度容差必须大于 0');
	}
	if (!Number.isFinite(options.clearance) || options.clearance < 0 || options.tolerance < EPS) throw new Error('净距不得为负，长度容差不得小于 0.001mil');
	if (!Number.isFinite(options.minAmplitude ?? 0) || (options.minAmplitude ?? 0) < 0 || (options.minAmplitude ?? 0) > options.amplitude) throw new Error('最小振幅 H 须大于等于 0，且不得超过最大振幅');
	if (options.dynamicAmplitude !== undefined && typeof options.dynamicAmplitude !== 'boolean') throw new Error('动态振幅开关无效');
	if (options.differential !== undefined && typeof options.differential !== 'boolean') throw new Error('差分模式开关无效');
	if (!['auto', 'left', 'right'].includes(options.side)) throw new Error('无效补长方向');
	if (options.mode !== undefined && !['direct', 'push'].includes(options.mode)) throw new Error('无效避让模式');
	if (options.pattern !== undefined && !['single', 'double', 'large', 'mixed'].includes(options.pattern)) throw new Error('无效等长方式');
	if (options.lobes !== undefined && (!Number.isInteger(options.lobes) || options.lobes < 0 || options.lobes > 48)) throw new Error('波数须为0至48的整数，0表示自动');
	if (options.pattern === 'double' && options.lobes === 1) throw new Error('双边蛇形至少需要2波（每侧至少1波）；也可设0自动');
	if (chosen.some(r => r.locked || r.unsupported || r.lines.some(l => l.locked))) throw new Error('锁定或不支持的路径不能补长');
	if (options.target === 'longest' && chosen.length < 2) throw new Error('自动匹配至少需要两个目标；单条走线请指定目标长度');
	const longest = Math.max(...chosen.map(routeLength));
	const target = options.target === 'longest' ? longest : options.target;
	if (!Number.isFinite(target) || target <= 0 || target + options.tolerance < longest) throw new Error('目标长度不得小于当前最长走线；本插件仅补长');
	if (target > 1000000 || options.amplitude > 100000 || options.pitch > 100000) throw new Error('参数过大，请检查 mil/mm 单位');
	if (chosen.some(r => r.lines.some(l => options.pitch + EPS < l.width + options.clearance))) throw new Error('蛇形间距须至少为目标最大线宽 + 避让净距');
	return target;
}

// A lobe has two vertical arms and four 45-degree bevels. Its extra length is
// 2*A + (4*sqrt(2)-8)*c; c=min(baseBevel,A/2). This gives an exact inverse.
function dimensions(extra: number, baseBevel: number) {
	const shallow = extra <= 2 * K * baseBevel;
	const amplitude = shallow ? extra / K : extra / 2 + (4 - 2 * Math.SQRT2) * baseBevel;
	return { amplitude, bevel: Math.min(baseBevel, amplitude / 2) };
}
function extraAt(amplitude: number, baseBevel: number) {
	return 2 * amplitude + (4 * Math.SQRT2 - 8) * Math.min(baseBevel, amplitude / 2);
}
function frame(line: Line) {
	const length = lineLength(line);
	const u = { x: (line.end.x - line.start.x) / length, y: (line.end.y - line.start.y) / length };
	return { length, point: (x: number, y: number) => ({ x: line.start.x + u.x * x - u.y * y, y: line.start.y + u.y * x + u.x * y }) };
}
function pieces(line: Line, points: Point[]): Line[] {
	const compact = points.filter((p, i) => !i || dist(p, points[i - 1]) > 1e-8);
	for (let i = compact.length - 2; i > 0; i--) {
		const a = compact[i - 1], b = compact[i], c = compact[i + 1];
		const ab = { x: b.x - a.x, y: b.y - a.y }, bc = { x: c.x - b.x, y: c.y - b.y };
		if (Math.abs(ab.x * bc.y - ab.y * bc.x) < 1e-8 && ab.x * bc.x + ab.y * bc.y > 0) compact.splice(i, 1);
	}
	return compact.slice(1).map((end, i) => ({ ...line, id: i === 0 ? line.id : `${line.id}/length/${i}`, start: compact[i], end }));
}

export function* serpentCandidates(line: Line, extra: number, options: WaveOptions, placement = 0, anchor?: Point, priority?: WindowPriority): Generator<Line[]> {
	if (continuous(options)) { yield* roundedCandidates(line, extra, options, placement, anchor, priority); return; }
	const { length, point } = frame(line);
	const guard = Math.max(line.width + options.clearance, 1);
	const usable = length - 2 * guard;
	const baseBevel = (line.width + options.clearance) / 2;
	const minCells = Math.max(1, Math.ceil(extra / extraAt(options.amplitude, baseBevel) - 1e-10));
	const signs = options.side === 'left' ? [1] : options.side === 'right' ? [-1] : [1, -1];
	for (let n = minCells; n <= Math.min(48, minCells + 8); n++) {
		const { amplitude: a, bevel: c } = dimensions(extra / n, baseBevel);
		if (a > options.amplitude + 1e-8) continue;
		const flat = Math.max(0, options.pitch - 2 * c);
		const span = 4 * c + flat;
		const occupied = n * span + (n - 1) * options.pitch;
		if (occupied > usable + 1e-8) continue;
		const placements = [0.5, 0, 1, 0.25, 0.75];
		const offsets = anchor ? [Math.max(guard, Math.min(length - guard - occupied, ((anchor.x - line.start.x) * (line.end.x - line.start.x) + (anchor.y - line.start.y) * (line.end.y - line.start.y)) / length - occupied / 2))]
			: [...placements.slice(placement), ...placements.slice(0, placement)].map(fraction => guard + (usable - occupied) * fraction);
		const windows = signs.flatMap(sign => [...offsets, ...(!anchor ? padEndOffsets(line, options, guard, occupied) : [])].map(offset => ({ sign, offset, score: priority?.(line, offset, occupied, 'large', sign) ?? 0 }))).filter(w => Number.isFinite(w.score)).sort((a, b) => b.score - a.score);
		for (const { sign, offset } of windows) {
			const points: Point[] = [line.start];
			let s = offset;
			for (let i = 0; i < n; i++) {
				points.push(...[[s, 0], [s + c, c], [s + c, a - c], [s + 2 * c, a], [s + 2 * c + flat, a], [s + 3 * c + flat, a - c], [s + 3 * c + flat, c], [s + span, 0]].map(([x, y]) => point(x, sign * y)));
				s += span + options.pitch;
			}
			points.push(line.end);
			yield pieces(line, points);
		}
	}
}

function boxDistance(line: Line, box: Box) {
	return copperBoxDistance(line, box);
}
function near(line: Line, box: Box, padding: number) {
	const a = copperBounds(line);
	return a.minX <= box.maxX + padding && a.maxX >= box.minX - padding && a.minY <= box.maxY + padding && a.maxY >= box.minY - padding;
}
const bounds = copperBounds;
const lineIndexes = new WeakMap<Line[], SpatialIndex<Line>>();
const obstacleIndexes = new WeakMap<Obstacle[], SpatialIndex<Obstacle>>();
function lineIndex(lines: Line[]) {
	let index = lineIndexes.get(lines);
	if (!index) { index = new SpatialIndex(lines, l => { const b = bounds(l), p = l.width / 2; return { minX: b.minX - p, maxX: b.maxX + p, minY: b.minY - p, maxY: b.maxY + p }; }); lineIndexes.set(lines, index); }
	return index;
}
function obstacleIndex(obstacles: Obstacle[]) {
	let index = obstacleIndexes.get(obstacles); if (!index) { index = new SpatialIndex(obstacles, o => o.box); obstacleIndexes.set(obstacles, index); } return index;
}

function collision(candidate: Line[], original: Line, context: Line[], obstacles: Obstacle[], boundaries: Line[], clearance: number, selfCheck = true, baseline?: ReadonlyMap<string, Line>): string | undefined {
	const area = candidate.reduce((a, l) => { const b = bounds(l); return { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) }; }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
	const pad = clearance + original.width / 2;
	context = lineIndex(context).query(area, pad).filter(l => l.layer === original.layer);
	obstacles = obstacleIndex(obstacles).query(area, pad).filter(o => o.layer === original.layer || o.layer === 12);
	boundaries = lineIndex(boundaries).query(area, pad);
	const cumulative = [0];
	const selfBounds = selfCheck ? candidate.map(bounds) : [];
	for (const line of candidate) cumulative.push(cumulative[cumulative.length - 1] + lineLength(line));
	for (let i = 0; i < candidate.length; i++) {
		const a = candidate[i];
		const aBounds = selfBounds[i];
		for (let j = i + 2; selfCheck && j < candidate.length; j++) {
			if (a.layer !== candidate[j].layer) continue;
			const separation = cumulative[j] - cumulative[i + 1];
			const bBounds = selfBounds[j], threshold = (separation > Math.PI * original.width ? original.width : 1e-8) + 1e-7;
			const dx = Math.max(0, aBounds.minX - bBounds.maxX, bBounds.minX - aBounds.maxX);
			const dy = Math.max(0, aBounds.minY - bBounds.maxY, bBounds.minY - aBounds.maxY);
			// Exact bounds include arc extrema. Their distance is a lower bound,
			// so only nearby pairs need the analytic line/arc intersection test.
			if (dx * dx + dy * dy > threshold * threshold) continue;
			const gap = copperDistance(a, candidate[j]);
			// Nearby samples around one rounded bend belong to the same copper join.
			if (gap < 1e-8 || (separation > Math.PI * original.width && gap + EPS < original.width)) return '蛇形线自交或铜线重叠';
		}
		const onOriginal = !a.arcAngle && pointDistance(a.start, original.start, original.end) < EPS && pointDistance(a.end, original.start, original.end) < EPS;
		const oldSource = baseline?.get(original.id) ?? baseline?.get(original.id.split('/length/')[0]);
		const onBaseline = onOriginal && (!baseline || (!!oldSource && !oldSource.arcAngle && pointDistance(a.start, oldSource.start, oldSource.end) < EPS && pointDistance(a.end, oldSource.start, oldSource.end) < EPS));
		for (const b of context) {
			if (b.id === original.id || a.layer !== b.layer || !near(a, bounds(b), clearance + (a.width + b.width) / 2)) continue;
			if (onBaseline) {
				const old = baseline?.get(b.id) ?? baseline?.get(b.id.split('/length/')[0].split('/mixed/')[0]);
				if (!baseline || (old && !b.arcAngle && pointDistance(b.start, old.start, old.end) < EPS && pointDistance(b.end, old.start, old.end) < EPS)) continue;
			}
			const gap = copperDistance(a, b) - (a.width + b.width) / 2;
			const sharedJoin = a.net === b.net && [original.start, original.end].some(p => [b.start, b.end].some(q => dist(p, q) < EPS) && Math.min(dist(a.start, p), dist(a.end, p)) <= Math.PI * original.width);
			// Adjacent copper deliberately overlaps at its common source endpoint.
			if (sharedJoin) continue;
			// New serpentine copper must clear same-net copper too, avoiding shortcuts.
			if (gap + EPS < (sharedJoin ? 0 : clearance)) return `与走线 ${b.net || b.id} 净距不足`;
		}
		if (onBaseline) continue;
		for (const obstacle of obstacles) {
			if (obstacle.layer !== a.layer && obstacle.layer !== 12) continue;
			if (!near(a, obstacle.box, clearance + a.width / 2)) continue;
			const gap = boxDistance(a, obstacle.box) - a.width / 2;
			if (gap + EPS < clearance) return `与固定障碍 ${obstacle.net || obstacle.id} 净距不足`;
		}
		for (const edge of boundaries) {
			if (!near(a, bounds(edge), clearance + a.width / 2)) continue;
			if (copperDistance(a, edge) - a.width / 2 + EPS < clearance) return '与板边净距不足';
		}
	}
	return undefined;
}

function capacity(line: Line, options: WaveOptions) {
	const guard = Math.max(line.width + options.clearance, 1);
	const bevel = (line.width + options.clearance) / 2;
	let lo = 0;
	let hi = continuous(options) ? waveExtraAt(options.amplitude, bevel, 48, options.pattern) : 48 * extraAt(options.amplitude, bevel);
	for (let i = 0; i < 40; i++) {
		const extra = (lo + hi) / 2;
		let fits = false;
		for (let n = 1; n <= 48; n++) {
			if (continuous(options)) {
				if ((options.lobes && n !== options.lobes) || (options.pattern === 'double' && n < 2)) continue;
				const m = waveMetrics(extra, options, line.width, n);
				if (m.amplitude <= options.amplitude && m.occupied <= lineLength(line) - 2 * guard) { fits = true; break; }
				continue;
			}
			const { amplitude, bevel: c } = dimensions(extra / n, bevel);
			if (amplitude <= options.amplitude && n * (2 * c + options.pitch) + (n - 1) * options.pitch <= lineLength(line) - 2 * guard) { fits = true; break; }
		}
		if (fits) lo = extra; else hi = extra;
	}
	return lo;
}

function* fitRoute(route: Route, delta: number, context: Line[], options: WaveOptions, obstacles: Obstacle[], boundaries: Line[], placement = 0, anchor?: Point, sections: LengthSection[] = [], preferred?: string, baseline?: ReadonlyMap<string, Line>, compactOnly = false): Steps<Line[]> {
	const priority = createSpacePriority(context, obstacles, boundaries, options);
	if (options.pattern === 'mixed') {
		const ids = new Set(route.lines.map(l => l.id));
		const external = context.filter(l => !ids.has(l.id));
		const result = yield* fitMixedSteps(route, delta, options, {
			candidates: (line, extra, tuning, placement) => serpentCandidates(line, extra, tuning, placement, undefined, priority), capacity, priority: priority.source, allowLarge: !compactOnly,
			check: (candidate, original, peers) => collision(candidate, original, external.concat(peers), obstacles, boundaries, options.clearance, true, baseline),
			adaptive: function* (line, extra, tuning, peers) {
				if (!options.dynamicAmplitude) return undefined;
				const context = external.concat(peers);
				return yield* fitAdaptiveLineSteps(line, extra, tuning, (candidate, probe) => collision(candidate, line, context, obstacles, boundaries, options.clearance, !probe, baseline), placement, undefined, undefined, priority);
			},
		}, placement);
		sections.push(...result.sections);
		return result.lines;
	}
	const ordered = [...route.lines].filter(l => !preferred || l.id === preferred).sort((a, b) => priority.source(b) - priority.source(a) || lineLength(b) - lineLength(a));
	if (options.dynamicAmplitude) for (const source of ordered) {
		yield `正在测量 ${route.net} 的局部振幅空间…`;
		const result = yield* fitAdaptiveLineSteps(source, delta, { ...options, pattern: options.pattern ?? 'large' }, (candidate, probe) => collision(candidate, source, context, obstacles, boundaries, options.clearance, !probe, baseline), placement, preferred && options.lobes ? [options.lobes] : undefined, anchor, priority);
		if (result) {
			sections.push({ sourceId: source.id, pattern: options.pattern ?? 'large', added: delta, start: source.start, end: source.end, amplitudes: result.amplitudes });
			return route.lines.flatMap(l => l.id === source.id ? result.lines : [l]);
		}
	}
	let reason = continuous(options) ? '可用直线不足或目标增量不满足波数与最小/最大振幅约束' : '可用直线长度不足';
	// Prefer a single tuning section so the rest of the original path stays intact.
	for (const original of ordered) {
		for (const candidate of serpentCandidates(original, delta, options, placement, anchor, priority)) {
			yield;
			const blocked = collision(candidate, original, context, obstacles, boundaries, options.clearance, true, baseline);
			if (!blocked) return route.lines.flatMap(l => l.id === original.id ? candidate : [l]);
			reason = blocked;
		}
	}
	let remaining = delta;
	const replacement = new Map<string, Line[]>();
	let working = [...context];
	for (const original of ordered) {
		const max = Math.min(remaining, capacity(original, options));
		if (max <= options.tolerance) continue;
		let found = false;
		for (const ratio of [1, 0.75, 0.5, 0.25, 0.125]) {
			const amount = max * ratio;
			if (amount <= options.tolerance) continue;
			for (const candidate of serpentCandidates(original, amount, options, placement, anchor, priority)) {
				yield;
				const blocked = collision(candidate, original, working, obstacles, boundaries, options.clearance, true, baseline);
				if (blocked) { reason = blocked; continue; }
				replacement.set(original.id, candidate);
				working = working.filter(l => l.id !== original.id).concat(candidate);
				remaining -= amount;
				found = true;
				break;
			}
			if (found) break;
		}
		if (remaining <= options.tolerance) return route.lines.flatMap(l => replacement.get(l.id) ?? [l]);
		yield;
	}
	throw new Error(`${route.net} 补长空间不足（尚差 ${remaining.toFixed(3)}mil；${reason}）。可调整间距 W、最小/最大振幅、波数、方向或目标长度`);
}

export function planLengths(lines: Line[], chosen: Route[], options: LengthOptions, obstacles: Obstacle[] = [], boundaries: Line[] = []): LengthPlan {
	return finish(planLengthsSteps(lines, chosen, options, obstacles, boundaries));
}

// A straight trunk between two parallel 45-degree joins can slide while one
// join grows and the other shrinks by the same length. This also lets an
// already-matched selected route make room without changing the target.
function* reflowSelectedSteps(lines: Line[], chosen: Route[], target: number, options: LengthOptions, obstacles: Obstacle[], boundaries: Line[]): Steps<LengthPlan | undefined> {
	if (chosen.length < 2 || chosen.length > 4 || chosen.some(r => r.id.startsWith('segment/') || r.locked || r.unsupported || r.lines.some(l => l.layer !== r.layer))) return undefined;
	const sources = chosen.map(r => [...r.lines].filter(l => !l.arcAngle && !l.locked).sort((a, b) => lineLength(b) - lineLength(a))[0]);
	if (sources.some(l => !l)) return undefined;
	const main = sources[0], length = lineLength(main), tangent = { x: (main.end.x - main.start.x) / length, y: (main.end.y - main.start.y) / length }, normal = { x: -tangent.y, y: tangent.x };
	if (sources.some(l => Math.abs((l.end.x - l.start.x) * tangent.y - (l.end.y - l.start.y) * tangent.x) > EPS)) return undefined;
	const position = (l: Line) => ((l.start.x + l.end.x) * normal.x + (l.start.y + l.end.y) * normal.y) / 2;
	const ranks = sources.map((_, i) => i).sort((a, b) => position(sources[a]) - position(sources[b]));
	const step = Math.max(1, Math.min(options.pitch / 4, Math.max(...sources.map(l => l.width + options.clearance)) / 4));
	const maximum = Math.min(32, Math.floor(options.amplitude / step));
	const baseline = new Map(lines.map(l => [l.id, l]));
	for (let radius = 1; radius <= maximum; radius++) for (let common = 0; common <= radius; common++) for (const sign of [1, -1]) {
		const spread = radius - common;
		if (common + spread * (chosen.length - 1) > maximum) continue;
		yield '正在利用上方/两侧空间协调目标走线，保持各路径原长…';
		try {
			const shifted = chosen.map((route, i) => {
				const rank = sign > 0 ? ranks.indexOf(i) : chosen.length - 1 - ranks.indexOf(i), offset = sign * step * (common + spread * rank), source = sources[i];
				if (!offset) return route;
				const after = { ...source, start: { x: source.start.x + normal.x * offset, y: source.start.y + normal.y * offset }, end: { x: source.end.x + normal.x * offset, y: source.end.y + normal.y * offset } };
				const moved = planSegmentRoute(route, new Map([[source.id, { after, moved: true }]])), pieces = materialize(moved).map(p => p.after);
				if (dist(moved.points[0], route.points[0]) > EPS || dist(moved.points.at(-1)!, route.points.at(-1)!) > EPS) throw new Error('目标位移不能改变原端点');
				// Keep a one-to-one route correspondence and exact centreline length;
				// arbitrary detours or changes of terminal/branch topology are excluded.
				if (pieces.length !== route.lines.length || new Set(pieces.map(l => l.id)).size !== pieces.length || pieces.some(l => !route.lines.some(old => old.id === l.id)) || Math.abs(pieces.reduce((n, l) => n + lineLength(l), 0) - routeLength(route)) > EPS) throw new Error('目标位移不能保持原长');
				return { ...route, points: moved.points, lines: pieces };
			});
			const replacement = new Map(shifted.flatMap(r => r.lines.map(l => [l.id, l] as const))), layout = lines.map(l => replacement.get(l.id) ?? l);
			for (const route of shifted) {
				if (collision(route.lines, sources[chosen.findIndex(r => r.id === route.id)], [], [], [], options.clearance)) throw new Error('位移后目标路径自身重叠');
				const own = new Set(route.lines.map(l => l.id)), outside = layout.filter(l => !own.has(l.id));
				for (const after of route.lines) {
					const before = baseline.get(after.id)!;
					if (sameLineGeometry(before, after)) continue;
					if (collision([after], before, outside, obstacles, boundaries, options.clearance, false, baseline)) throw new Error('位移后目标净距不足');
				}
			}
			const plan = yield* planLengthsSteps(layout, shifted, { ...options, target, mode: 'direct' }, obstacles, boundaries, false);
			const moved = shifted.filter((r, i) => r.lines.some(l => !sameLineGeometry(l, chosen[i].lines.find(old => old.id === l.id)!)));
			plan.rows = plan.rows.map((row, i) => ({ ...row, before: routeLength(chosen[i]), added: row.after - routeLength(chosen[i]) }));
			plan.changed = plan.rows.filter(r => r.added > EPS).length;
			plan.options = { ...options };
			plan.pushed = moved.map(r => ({ id: r.id, net: r.net, lines: r.lines.length }));
			plan.pushedPreview = moved.map(r => plan.groups[chosen.findIndex(original => original.id === r.id)]);
			return plan;
		} catch { /* Retain constraints and try the next bounded, length-preserving slide. */ }
	}
	return undefined;
}
function* jointTargets(lines: Line[], chosen: Route[], target: number, options: LengthOptions, obstacles: Obstacle[], boundaries: Line[], routes: Route[], orders: Route[][]): Steps<LengthPlan | undefined> {
	const baseline = new Map(lines.map(l => [l.id, l]));
	const used = new Set(chosen.flatMap(r => r.lines.map(l => l.id)));
	const fixed = new Set(chosen.filter(r => target - routeLength(r) <= options.tolerance).flatMap(r => r.lines.map(l => l.id)));
	const modes: TuningPattern[] = options.pattern === 'mixed' ? ['single', 'double', 'large'] : [options.pattern ?? 'large'];
	for (const order of orders) {
		let budget = 240;
		const groups = new Map<string, Line[]>(), sections: LengthSection[] = [];
		function* search(index: number, context: Line[], frozen: Set<string>): Steps<LengthPlan | undefined> {
			if (budget <= 0) return undefined;
			if (index === order.length) {
				try {
					const shove = options.mode === 'push' ? yield* shoveLengthsSteps(lines, routes, chosen, chosen.map(r => groups.get(r.id)!), options.clearance, obstacles, boundaries) : { lines: context, pushed: [], preview: [] };
					const rows = chosen.map(r => { const before = routeLength(r), group = groups.get(r.id)!, after = group.reduce((n, l) => n + lineLength(l), 0); return { id: r.id, net: r.net, before, after, added: after - before, error: after - target, segments: group.length, styles: [...new Set(sections.filter(s => r.lines.some(l => l.id === s.sourceId)).map(s => s.pattern))] }; });
					if (rows.some(r => Math.abs(r.error) > options.tolerance) || shove.lines.length > lines.length + 4096) return undefined;
					return { lines: shove.lines, target, rows, groups: chosen.map(r => groups.get(r.id)!), changed: rows.filter(r => r.added > EPS).length, options: { ...options }, pushed: shove.pushed, pushedPreview: shove.preview, sections: [...sections] };
				}
				catch { return undefined; }
			}
			const route = order[index], delta = target - routeLength(route);
			if (delta <= options.tolerance) { groups.set(route.id, route.lines); return yield* search(index + 1, context, frozen); }
			const peers = options.mode === 'push' ? context.filter(l => l.net === route.net || frozen.has(l.id) || !used.has(l.id)) : context;
			const priority = createSpacePriority(peers, obstacles, boundaries, options);
			const seen = new Set<string>();
			for (const source of [...route.lines].sort((a, b) => priority.source(b) - priority.source(a) || lineLength(b) - lineLength(a))) for (const pattern of modes) {
				const counts = options.lobes && pattern !== 'large' && options.pattern !== 'mixed' ? [options.lobes] : Array.from({ length: 16 }, (_, i) => i + 1).filter(n => pattern !== 'double' || n >= 2);
				for (const n of counts) {
					const r = (source.width + options.clearance) / 2, w = options.pitch;
					const span = pattern === 'double' ? n * w + 2 * r : pattern === 'large' ? n * (w + 2 * r) + (n - 1) * w : (2 * n - 1) * w + 2 * r;
					if (span > lineLength(source) - source.width - 2 * options.clearance) continue;
				for (const placement of [1, 2, 0]) for (const side of options.side === 'auto' ? ['left', 'right'] as const : [options.side]) {
					if (budget-- <= 0) return undefined;
					yield `正在联合协调 ${index + 1}/${order.length}：${route.net} 的振幅和补长位置…`;
					const result = yield* fitAdaptiveLineSteps(source, delta, { ...options, pattern, side }, (candidate, probe) => collision(candidate, source, peers, obstacles, boundaries, options.clearance, !probe, baseline), placement, [n], undefined, priority);
					if (!result) continue;
					const key = JSON.stringify(result.lines.map(l => [l.start.x, l.start.y, l.end.x, l.end.y]));
					if (seen.has(key)) continue;
					seen.add(key);
					if (route.lines.some(l => l.id !== source.id && collision([l], l, peers, obstacles, boundaries, options.clearance, false, baseline))) continue;
					const group = route.lines.flatMap(l => l.id === source.id ? result.lines : [l]);
					groups.set(route.id, group);
					sections.push({ sourceId: source.id, pattern, added: delta, start: source.start, end: source.end, amplitudes: result.amplitudes });
					const ids = new Set(route.lines.map(l => l.id));
					const next = context.filter(l => !ids.has(l.id)).concat(group);
					const found = yield* search(index + 1, next, new Set([...frozen, ...group.map(l => l.id)]));
					if (found) return found;
					sections.pop(); groups.delete(route.id);
				}
				}
			}
			return undefined;
		}
		const found = yield* search(0, lines, new Set(fixed));
		if (found) return found;
	}
	return undefined;
}
export function* planLengthsSteps(lines: Line[], chosen: Route[], options: LengthOptions, obstacles: Obstacle[] = [], boundaries: Line[] = [], advanced = true): Steps<LengthPlan> {
	validate(chosen, options);
	const pads = (options as PadOptions)[PAD_PRIORITY] ?? createPadPriority(lines, chosen, obstacles);
	let plan: LengthPlan | undefined;
	if (pads && !(options as PadOptions)[PAD_PRIORITY]) {
		yield '优先检查靠近焊盘端的补长位置…';
		try {
			plan = yield* planLengthsSearchSteps(lines, chosen, { ...options, [PAD_PRIORITY]: { ...pads, endsOnly: true } } as PadOptions, obstacles, boundaries, !!options.differential);
			assert45Changes(lines, plan.lines);
		} catch { plan = undefined; yield '焊盘端候选不足，继续检查其余区段及45°重排…'; }
	}
	plan ??= yield* planLengthsSearchSteps(lines, chosen, pads ? { ...options, [PAD_PRIORITY]: pads } as PadOptions : options, obstacles, boundaries, advanced);
	assert45Changes(lines, plan.lines);
	plan.options = { ...options };
	delete (plan.options as PadOptions)[PAD_PRIORITY];
	return plan;
}
function* planLengthsSearchSteps(lines: Line[], chosen: Route[], options: LengthOptions, obstacles: Obstacle[] = [], boundaries: Line[] = [], advanced = true): Steps<LengthPlan> {
	const target = validate(chosen, options);
	if (!advanced) return yield* planLengthsCoreSteps(lines, chosen, options, obstacles, boundaries, false);
	const pair = options.differential ? differentialPair(chosen, options) : undefined;
	if (pair) {
		const slid = yield* differentialSlideSteps(lines, chosen, target, options, obstacles, boundaries, pair, collision);
		if (slid) return slid;
		const patterns: TuningPattern[] = options.pattern === 'single' || options.pattern === 'double' ? [options.pattern] : ['single', 'double'];
		for (const pattern of patterns) {
			const paired = yield* pairedMeanderSteps(lines, chosen, target, options, obstacles, boundaries, pair, pattern, collision);
			if (paired) return paired;
			try {
				const tuning = { ...options, pattern, amplitude: Math.min(options.amplitude, pair.limit), minAmplitude: options.pattern === 'large' ? 0 : options.minAmplitude };
				const plan = yield* planLengthsCoreSteps(lines, chosen, tuning, obstacles, boundaries, true, { compactOnly: true, pair });
				if (!pairCoupled(plan.groups, chosen.map(r => r.lines), pair)) continue;
				plan.options = { ...options }; return plan;
			} catch { /* Try the other compact form before any large fold. */ }
		}
		const folded = yield* pairedMeanderSteps(lines, chosen, target, options, obstacles, boundaries, pair, 'large', collision);
		if (folded) return folded;
		try {
			const plan = yield* planLengthsCoreSteps(lines, chosen, options, obstacles, boundaries, true, { pair });
			if (pairCoupled(plan.groups, chosen.map(r => r.lines), pair)) return plan;
		} catch { /* Never submit a loose independent detour in differential mode. */ }
		throw new Error('差分模式未找到同时满足等长、净距和成对贴近约束的方案；可设波数0自动、调整W/H或最大振幅，未提交');
	}
	if (options.pattern && options.pattern !== 'large') {
		yield '优先检查无需大折返的紧凑蛇形方案…';
		try { return yield* planLengthsCoreSteps(lines, chosen, options, obstacles, boundaries, true, { compactOnly: true }); }
		catch { yield '紧凑蛇形候选不足，继续检查局部折返及重排…'; }
	}
	return yield* planLengthsCoreSteps(lines, chosen, options, obstacles, boundaries, true);
}

function* planLengthsCoreSteps(lines: Line[], chosen: Route[], options: LengthOptions, obstacles: Obstacle[] = [], boundaries: Line[] = [], advanced = true, policy: PlanningPolicy = {}): Steps<LengthPlan> {
	const target = validate(chosen, options);
	if (advanced && options.mode === 'push' && chosen.length >= 2 && chosen.every(r => r.lines.every(l => l.layer === r.layer))) {
		const bundle = yield* bundleLengthsSteps(lines, chosen, target, options, obstacles, boundaries, collision, policy);
		if (bundle) {
			const routes = yield* buildRoutesSteps(lines, obstacles);
			const result = yield* shoveLengthsSteps(lines, routes, chosen, bundle.groups, options.clearance, obstacles, boundaries);
			const rows = chosen.map((r, i) => {
				const before = routeLength(r), after = bundle.groups[i].reduce((n, l) => n + lineLength(l), 0);
				if (Math.abs(after - target) > options.tolerance) throw new Error('整组重排长度超出容差，未提交');
				return { id: r.id, net: r.net, before, after, added: after - before, error: after - target, segments: bundle.groups[i].length, styles: [...new Set(bundle.sections.filter(s => r.lines.some(l => l.id === s.sourceId)).map(s => s.pattern))] };
			});
			const moved = chosen.filter((r, i) => r.lines.length !== bundle.groups[i].length || r.lines.some(l => !bundle.groups[i].some(after => after.id === l.id && sameLineGeometry(l, after))));
			return { lines: result.lines, target, rows, groups: bundle.groups, changed: rows.filter(r => r.added > EPS).length, options: { ...options }, pushed: moved.map(r => ({ id: r.id, net: r.net, lines: bundle.groups[chosen.indexOf(r)].length })), pushedPreview: moved.map(r => bundle.groups[chosen.indexOf(r)]), sections: bundle.sections };
		}
		if (policy.compactOnly || policy.bundleOnly) throw new Error('有限整组候选未找到可行组合');
		if (options.target === 'longest' && chosen.length === 2 && !policy.pair && chosen.every(r => !r.id.startsWith('segment/'))) {
			// First retain the original target using the equal-spacing translator.
			// If that cannot fit, auto-longest may grow the common target to let
			// both routes reflow using fixed-direction supports and real snakes.
			const preserved = yield* reflowSelectedSteps(lines, chosen, target, options, obstacles, boundaries);
			if (preserved) return preserved;
			const step = Math.max(options.pitch, ...chosen.flatMap(r => r.lines.map(l => l.width + options.clearance)));
			for (const multiple of [1, 2, 4, 8, 12, 16]) {
				const nextTarget = target + step * multiple;
				if (nextTarget > 1000000) break;
				yield `按45°规则调整目标间距，检查共同目标 ${nextTarget.toFixed(3)}mil…`;
				try {
					const plan = yield* planLengthsCoreSteps(lines, chosen, { ...options, target: nextTarget }, obstacles, boundaries, true, { bundleOnly: true });
					assert45Changes(lines, plan.lines);
					plan.options = { ...options }; plan.originalTarget = target; return plan;
				} catch { /* Keep the target explicit and try the next bounded level. */ }
			}
		}
	}
	if (advanced && options.dynamicAmplitude && options.pattern === 'mixed' && chosen.length > 1) {
		yield '正在检查整组双边蛇形方案…';
		try {
			const plan = yield* planLengthsCoreSteps(lines, chosen, { ...options, pattern: 'double', lobes: 0 }, obstacles, boundaries, false, policy);
			plan.options = { ...options };
			return plan;
		}
		catch { /* Continue with per-window combinations. */ }
	}

	const baseline = new Map(lines.map(l => [l.id, l]));
	const used = new Set<string>();
	for (const route of chosen) for (const line of route.lines) {
		if (used.has(line.id) || !lines.some(l => l.id === line.id)) throw new Error('目标重复或不属于当前场景，请重新读取');
		used.add(line.id);
	}
	let lastError: unknown;
	let pushError: unknown;
	const orders = [...new Map([chosen, [...chosen].reverse(), [...chosen].sort((a, b) => routeLength(a) - routeLength(b))].map(order => [JSON.stringify(order.map(r => r.id)), order])).values()];
	const routes = options.mode === 'push' ? yield* buildRoutesSteps(lines, obstacles) : [];
	const fixedIds = new Set(routes.filter(r => r.lines.some(l => used.has(l.id))).flatMap(r => r.lines.filter(l => !used.has(l.id)).map(l => l.id)));
	for (const r of chosen) if (target - routeLength(r) <= options.tolerance) r.lines.forEach(l => fixedIds.add(l.id));
	const changed = chosen.filter(r => target - routeLength(r) > options.tolerance);
	const axis = [...changed[0]?.lines ?? []].sort((a, b) => lineLength(b) - lineLength(a))[0];
	const tangent = axis ? { x: (axis.end.x - axis.start.x) / lineLength(axis), y: (axis.end.y - axis.start.y) / lineLength(axis) } : { x: 1, y: 0 };
	const normal = { x: -tangent.y, y: tangent.x };
	const representatives = new Map(changed.map(r => {
		const parallel = r.lines.filter(l => Math.abs((l.end.x - l.start.x) * tangent.y - (l.end.y - l.start.y) * tangent.x) < EPS);
		return [r.id, [...(parallel.length ? parallel : r.lines)].sort((a, b) => lineLength(b) - lineLength(a))[0]];
	}));
	const position = (r: Route) => { const l = representatives.get(r.id)!; return ((l.start.x + l.end.x) * normal.x + (l.start.y + l.end.y) * normal.y) / 2; };
	const nestedOrder = [...changed].sort((a, b) => position(a) - position(b));
	const cuts = options.dynamicAmplitude ? chosen.filter(r => !changed.includes(r)).flatMap(r => r.lines.filter(l => Math.abs((l.end.x - l.start.x) * tangent.y - (l.end.y - l.start.y) * tangent.x) < EPS).sort((a, b) => lineLength(b) - lineLength(a)).slice(0, 1).map(l => ((l.start.x + l.end.x) * normal.x + (l.start.y + l.end.y) * normal.y) / 2)).sort((a, b) => a - b) : [];
	const bucket = (r: Route) => cuts.filter(c => position(r) > c).length;
	const bundle = (r: Route) => changed.filter(other => bucket(other) === bucket(r));
	for (const ranked of [nestedOrder, [...nestedOrder].reverse()]) {
		const order = [...chosen.filter(r => !changed.includes(r)), ...ranked];
		if (!orders.some(o => o.every((r, i) => r.id === order[i].id))) orders.push(order);
	}
	const spread = (continuous(options) ? 2 : 4) * Math.max(...chosen.flatMap(r => r.lines.map(l => l.width + options.clearance)));
	const nestedOptions = (route: Route, direction: number): WaveOptions => {
		const l = representatives.get(route.id);
		if (!l) return options;
		const aligned = ((l.end.x - l.start.x) * tangent.x + (l.end.y - l.start.y) * tangent.y) >= 0 ? 1 : -1;
		const members = options.dynamicAmplitude ? bundle(route) : changed;
		const ranked = nestedOrder.filter(r => members.includes(r));
		const rank = ranked.findIndex(r => r.id === route.id);
		const depth = direction < 0 ? members.length - 1 - rank : rank;
		const nearest = cuts.length ? [...cuts].sort((a, b) => Math.abs(position(route) - a) - Math.abs(position(route) - b))[0] : undefined;
		const outward = nearest === undefined || position(route) > nearest ? 1 : -1;
		const result: WaveOptions = { ...options, side: direction * outward * aligned > 0 ? 'left' : 'right', pitch: options.pitch + (continuous(options) || options.dynamicAmplitude ? 0 : spread * depth) };
		if (continuous(options) || options.dynamicAmplitude) {
			let n = continuous(options) && options.lobes ? options.lobes : options.dynamicAmplitude ? 4 : Math.max(...members.map(r => waveCounts(target - routeLength(r), options, representatives.get(r.id)!.width)[0] || 49));
			if (options.dynamicAmplitude && !options.lobes) while (n > (options.pattern === 'double' ? 2 : 1) && members.some(r => {
				const source = representatives.get(r.id)!, base = (source.width + options.clearance) / 2;
				const occupied = options.pattern === 'large' ? n * (options.pitch + 2 * base) + (n - 1) * options.pitch : options.pattern === 'double' ? n * options.pitch + 2 * base : (2 * n - 1) * options.pitch + 2 * base;
				return occupied > lineLength(source) - source.width - 2 * options.clearance;
			})) n--;
			result.lobes = n;
		}
		return result;
	};
	const attempts = [
		...orders.map(order => ({ order, pushing: false, placement: 0, nesting: 0 })),
		...(options.mode === 'push' ? [0, 1, 2, 3, 4].flatMap(placement => orders.map(order => ({ order, pushing: true, placement, nesting: 0 }))) : []),
		...(options.mode === 'push' && options.pattern !== 'mixed' ? [-1, 1].flatMap(nesting => [0, 1, 2, 3, 4].flatMap(placement => orders.map(order => ({ order, pushing: true, placement, nesting })))) : []),
	];
	let reflowChecked = false;
	for (const { order, pushing, placement, nesting } of attempts) {
		if (pushing && advanced && !policy.compactOnly && !policy.pair && !reflowChecked) {
			reflowChecked = true;
			const reflow = yield* reflowSelectedSteps(lines, chosen, target, options, obstacles, boundaries);
			if (reflow) return reflow;
		}
		let shoving = false;
		try {
			let anchor: Point | undefined;
			const anchors = new Map<string, Point>();
			if (nesting) {
				for (const members of options.dynamicAmplitude ? [...new Set(changed.map(bucket))].map(b => changed.filter(r => bucket(r) === b)) : [changed]) {
				let lo = -Infinity, hi = Infinity;
				for (const r of members) {
					const l = representatives.get(r.id)!;
					if (Math.abs((l.end.x - l.start.x) * tangent.y - (l.end.y - l.start.y) * tangent.x) > EPS) throw new Error('选中方向不适合共用蛇形窗口');
					const tuning = nestedOptions(r, nesting);
					const delta = target - routeLength(r), bevel = (l.width + options.clearance) / 2;
					const n = continuous(options) || options.dynamicAmplitude ? tuning.lobes! : Math.max(1, Math.ceil(delta / extraAt(options.amplitude, bevel) - 1e-10));
					const c = dimensions(delta / n, bevel).bevel;
					const half = options.dynamicAmplitude ? (options.pattern === 'large' ? n * (tuning.pitch + 2 * bevel) + (n - 1) * tuning.pitch : options.pattern === 'double' ? n * tuning.pitch + 2 * bevel : (2 * n - 1) * tuning.pitch + 2 * bevel) / 2 : continuous(options) ? waveMetrics(delta, tuning, l.width, n).occupied / 2 : (n * (2 * c + tuning.pitch) + (n - 1) * tuning.pitch) / 2;
					const positions = [l.start, l.end].map(p => p.x * tangent.x + p.y * tangent.y);
					const guard = Math.max((options.dynamicAmplitude ? l.width / 2 : l.width) + options.clearance, 1);
					lo = Math.max(lo, Math.min(...positions) + guard + half); hi = Math.min(hi, Math.max(...positions) - guard - half);
				}
				if (lo > hi || !Number.isFinite(lo + hi)) throw new Error('没有共用补长窗口');
				const position = lo + (hi - lo) * [0.5, 0, 1, 0.25, 0.75][placement];
				anchor = { x: tangent.x * position, y: tangent.y * position };
				for (const r of members) anchors.set(r.id, anchor);
				}
			}
			let context = [...lines];
			const frozen = new Set(fixedIds);
			const groups = new Map<string, Line[]>();
			const sections: LengthSection[] = [];
			for (let i = 0; i < order.length; i++) {
				const route = order[i];
				yield `正在规划 ${i + 1}/${order.length}：${route.net}`;
				const delta = target - routeLength(route);
				const obstaclesForTuning = pushing ? context.filter(l => l.net === route.net || frozen.has(l.id)) : context;
				const tuning = nesting ? nestedOptions(route, nesting) : options;
				if (options.side !== 'auto' && tuning.side !== options.side) throw new Error('所选方向无法形成嵌套补长');
				const result = delta <= options.tolerance ? route.lines : yield* fitRoute(route, delta, obstaclesForTuning, tuning, obstacles, boundaries, placement, anchors.get(route.id) ?? anchor, sections, nesting ? representatives.get(route.id)?.id : undefined, baseline, policy.compactOnly);
				groups.set(route.id, result);
				result.forEach(l => frozen.add(l.id));
				const oldIds = new Set(route.lines.map(l => l.id));
				context = context.filter(l => !oldIds.has(l.id)).concat(result);
			}
			let pushed: PushedRoute[] = [];
			let pushedPreview: Line[][] = [];
			if (pushing) {
				shoving = true;
				yield '正在为补长方案推挤周围走线…';
				const result = yield* shoveLengthsSteps(lines, routes, chosen, chosen.map(r => groups.get(r.id)!), options.clearance, obstacles, boundaries);
				context = result.lines; pushed = result.pushed; pushedPreview = result.preview;
			}
			const rows = chosen.map(r => {
				const before = routeLength(r);
				const pieces = groups.get(r.id)!;
				const after = pieces.reduce((n, l) => n + lineLength(l), 0);
				if (Math.abs(after - target) > options.tolerance + 1e-7) throw new Error('生成长度超出容差，未提交');
				const styles = options.pattern === 'mixed' ? [...new Set(sections.filter(s => r.lines.some(l => l.id === s.sourceId)).map(s => s.pattern))] : undefined;
				return { id: r.id, net: r.net, before, after, added: after - before, error: after - target, segments: pieces.length, ...(styles ? { styles } : {}) };
			});
			if (context.length > lines.length + 4096) throw new Error('补长段数过多，请减少目标长度');
			if (policy.pair && !pairCoupled(chosen.map(r => groups.get(r.id)!), chosen.map(r => r.lines), policy.pair)) throw new Error('差分补长区域与另一条走线距离过大');
			return { lines: context, target, rows, groups: chosen.map(r => groups.get(r.id)!), changed: rows.filter(r => r.added > EPS).length, options: { ...options }, pushed, pushedPreview, ...(options.pattern === 'mixed' || options.dynamicAmplitude ? { sections } : {}) };
		}
		catch (error) { if (!nesting || !lastError) lastError = error; if (shoving) pushError = error; if (options.dynamicAmplitude && nesting) yield `候选未通过（${nesting}/${placement}）：${error instanceof Error ? error.message : String(error)}`; }
	}
	if (options.dynamicAmplitude && chosen.length > 1 && advanced && !policy.compactOnly && !policy.pair) {
		const joint = yield* jointTargets(lines, chosen, target, options, obstacles, boundaries, routes, [...orders].reverse());
		if (joint) return joint;

	}
	throw pushError ?? lastError;
}

// Measure host copper clipped to every planned segment. Native splitting,
// merging and endpoint reversal must not double-count or lose route length.
export function measureGroups(plan: LengthPlan, actual: Line[]): number[] {
	return plan.groups.map(group => group.reduce((total, line) => {
		const length = lineLength(line);
		const intervals: [number, number][] = [];
		for (const a of actual) {
			const span = copperInterval(a, line); if (!span) continue;
			const lo = Math.max(0, span[0]);
			const hi = Math.min(length, span[1]);
			if (hi > lo) intervals.push([lo, hi]);
		}
		intervals.sort((a, b) => a[0] - b[0]);
		let end = 0; let covered = 0;
		for (const [lo, hi] of intervals) { covered += Math.max(0, hi - Math.max(lo, end)); end = Math.max(end, hi); }
		if (length - covered > EPS) throw new Error('回读走线存在缺口，已停止提交');
		return total + covered;
	}, 0));
}


