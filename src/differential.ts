import type { Line, Point } from './geometry';
import type { Route, Obstacle } from './routes';
import type { LengthOptions, LengthPlan, TuningPattern } from './length-planner';
import type { Steps } from './work';
import { arcGeometry, copperInterval, copperLength, copperPoint, pointCopperDistance } from './copper';
import { profileExtra, profileGeometry } from './adaptive';
import { createSpacePriority } from './space-priority';
import { materialize, planSegmentRoute } from './push-routes';
import { assert45Changes } from './routing-direction';

export interface PairGeometry { sources: [Line, Line]; u: Point; normal: Point; low: number; high: number; middle: number; spacing: number; limit: number }
export interface PlanningPolicy { compactOnly?: boolean; pair?: PairGeometry; bundleOnly?: boolean }
const total = (r: Route) => r.lines.reduce((n, l) => n + copperLength(l), 0);
const distance = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y);

export function differentialPair(chosen: Route[], options: LengthOptions): PairGeometry {
	if (chosen.length !== 2 || chosen[0].net === chosen[1].net) throw new Error('差分模式每次请选择两个不同网络，且具有同层平行区段的走线');
	let best: PairGeometry | undefined, score = -Infinity;
	for (const a of chosen[0].lines.filter(l => !l.arcAngle)) for (const b of chosen[1].lines.filter(l => !l.arcAngle)) {
		if (a.layer !== b.layer) continue;
		let ux = (a.end.x - a.start.x) / copperLength(a), uy = (a.end.y - a.start.y) / copperLength(a);
		if (ux < -.001 || Math.abs(ux) < .001 && uy < 0) { ux = -ux; uy = -uy; }
		if (Math.abs((b.end.x - b.start.x) * uy - (b.end.y - b.start.y) * ux) > .001) continue;
		const sources: [Line, Line] = [a, b], u = { x: ux, y: uy }, normal = { x: -uy, y: ux }, along = (p: Point) => p.x * ux + p.y * uy, across = (p: Point) => p.x * normal.x + p.y * normal.y;
		const low = Math.max(...sources.map(l => Math.min(along(l.start), along(l.end)))), high = Math.min(...sources.map(l => Math.max(along(l.start), along(l.end)))), spacing = Math.abs(across(a.start) - across(b.start));
		if (high - low < options.pitch || spacing < (a.width + b.width) / 2 + options.clearance - .001) continue;
		const value = (high - low) / (1 + spacing);
		if (value <= score) continue;
		score = value; best = { sources, u, normal, low, high, spacing, middle: (across(a.start) + across(b.start)) / 2, limit: spacing + Math.max(a.width, b.width) + options.clearance };
	}
	if (!best) throw new Error('差分模式未找到同层且有足够重叠、间距的平行区段');
	return best;
}

/** Bound the distance along entire new copper using the 1-Lipschitz distance
 * function. Untouched fanout keeps its original separation. */
export function pairCoupled(groups: Line[][], originals: Line[][], pair: PairGeometry): boolean {
	for (let side = 0; side < 2; side++) {
		const other = groups[1 - side], before = originals[side];
		for (const line of groups[side]) {
			if (before.some(old => !!copperInterval(line, old))) continue;
			const peers = other.filter(l => l.layer === line.layer);
			if (!peers.length) return false;
			const gap = (t: number) => { const p = copperPoint(line, t); return Math.min(...peers.map(l => pointCopperDistance(p, l))); };
			const length = copperLength(line), pending = [{ a: 0, b: 1, da: gap(0), db: gap(1), depth: 0 }];
			while (pending.length) {
				const { a, b, da, db, depth } = pending.pop()!;
				if (Math.max(da, db) > pair.limit + .001) return false;
				if (Math.max(da, db) + length * (b - a) / 2 <= pair.limit + .001) continue;
				if (depth >= 16) return false;
				const mid = (a + b) / 2, dm = gap(mid);
				pending.push({ a, b: mid, da, db: dm, depth: depth + 1 }, { a: mid, b, da: dm, db, depth: depth + 1 });
			}
		}
	}
	return true;
}

// Parallel offsets of tangent lines/arcs have matching joins. The net turn of
// a complete meander is zero, so each offset adds exactly the same length.
function offsetPath(path: Line[], amount: number): Line[] | undefined {
	const result: Line[] = [];
	for (const l of path) {
		if (l.arcAngle) {
			const g = arcGeometry(l), radius = g.radius - Math.sign(g.sweep) * amount;
			if (radius <= .001) return undefined;
			const at = (p: Point) => ({ x: g.center.x + (p.x - g.center.x) * radius / g.radius, y: g.center.y + (p.y - g.center.y) * radius / g.radius });
			result.push({ ...l, start: at(l.start), end: at(l.end) });
		} else {
			const length = copperLength(l), dx = -(l.end.y - l.start.y) * amount / length, dy = (l.end.x - l.start.x) * amount / length;
			result.push({ ...l, start: { x: l.start.x + dx, y: l.start.y + dy }, end: { x: l.end.x + dx, y: l.end.y + dy } });
		}
	}
	return result;
}

type Check = (candidate: Line[], source: Line, context: Line[], obstacles: Obstacle[], boundaries: Line[], clearance: number, self?: boolean, baseline?: ReadonlyMap<string, Line>) => string | undefined;
/** Small skew can be removed by a parallel support move, without violating H. */
export function* differentialSlideSteps(lines: Line[], chosen: Route[], target: number, options: LengthOptions, obstacles: Obstacle[], boundaries: Line[], pair: PairGeometry, check: Check): Steps<LengthPlan | undefined> {
	const indices = chosen.map((r, i) => target - total(r) > options.tolerance ? i : -1).filter(i => i >= 0);
	if (indices.length !== 1) return undefined;
	const index = indices[0], route = chosen[index], delta = target - total(route), baseline = new Map(lines.map(l => [l.id, l])), own = new Set(route.lines.map(l => l.id)), external = lines.filter(l => !own.has(l.id));
	for (const source of [...route.lines].filter(l => !l.arcAngle).sort((a, b) => Number(b.id === pair.sources[index].id) - Number(a.id === pair.sources[index].id) || copperLength(b) - copperLength(a))) for (const sign of [1, -1]) {
		yield '正在平行调整差分走线的支撑线，补偿小长度差…';
		try {
			const length = copperLength(source), nx = -(source.end.y - source.start.y) / length, ny = (source.end.x - source.start.x) / length;
			const moved = (amount: number) => {
				const after = { ...source, start: { x: source.start.x + nx * amount, y: source.start.y + ny * amount }, end: { x: source.end.x + nx * amount, y: source.end.y + ny * amount } }, plan = planSegmentRoute(route, new Map([[source.id, { after, moved: true }]])), group = materialize(plan).map(p => p.after);
				if (group.length !== route.lines.length || group.some(l => !l.id) || distance(plan.points[0], route.points[0]) > .001 || distance(plan.points.at(-1)!, route.points.at(-1)!) > .001) throw new Error('固定接入不满足平移');
				if (route.lines.some((l, i) => i + 1 < route.lines.length && l.layer !== route.lines[i + 1].layer && distance(plan.points[i + 1], route.points[i + 1]) > .001)) throw new Error('平移不能移动过孔连接');
				assert45Changes(route.lines, group); return group;
			};
			const probe = moved(sign), slope = probe.reduce((n, l) => n + copperLength(l), 0) - total(route);
			if (slope <= .001) continue;
			const amount = delta / slope;
			if (amount > Math.min(options.amplitude, pair.limit)) continue;
			const group = moved(sign * amount), groups = chosen.map((r, i) => i === index ? group : r.lines);
			if (Math.abs(group.reduce((n, l) => n + copperLength(l), 0) - target) > .001 || !pairCoupled(groups, chosen.map(r => r.lines), pair)) continue;
			if (group.some(l => check([l], baseline.get(l.id)!, external, obstacles.filter(o => !(o.terminal && o.net === route.net)), boundaries, options.clearance, false, baseline)) || check(group, source, [], [], [], options.clearance)) continue;
			const rows = chosen.map((r, i) => { const before = total(r), after = groups[i].reduce((n, l) => n + copperLength(l), 0); return { id: r.id, net: r.net, before, after, added: after - before, error: after - target, segments: groups[i].length, styles: [] }; });
			return { lines: external.concat(group), target, rows, groups, changed: 1, options: { ...options }, pushed: [{ id: route.id, net: route.net, lines: group.length }], pushedPreview: [group], sections: [] };
		} catch { /* A support may be pinned or run out of a neighbouring join. */ }
	}
	return undefined;
}
export function* pairedMeanderSteps(lines: Line[], chosen: Route[], target: number, options: LengthOptions, obstacles: Obstacle[], boundaries: Line[], pair: PairGeometry, pattern: TuningPattern, check: Check): Steps<LengthPlan | undefined> {
	if (Math.abs(total(chosen[0]) - total(chosen[1])) > options.tolerance) return undefined;
	const extra = target - total(chosen[0]); if (extra <= options.tolerance) return undefined;
	const used = new Set(chosen.flatMap(r => r.lines.map(l => l.id))), external = lines.filter(l => !used.has(l.id)), baseline = new Map(lines.map(l => [l.id, l]));
	const virtualWidth = pair.spacing + Math.max(...pair.sources.map(l => l.width)), radius = (virtualWidth + options.clearance) / 2;
	const tuning = { ...options, pattern: pattern === 'large' ? 'single' as const : pattern, pitch: Math.max(options.pitch, 2 * radius) };
	const at = (x: number, y: number) => ({ x: pair.u.x * x + pair.normal.x * y, y: pair.u.y * x + pair.normal.y * y });
	const spine: Line = { ...pair.sources[0], width: virtualWidth, start: at(pair.low, pair.middle), end: at(pair.high, pair.middle) };
	const priority = createSpacePriority(external, obstacles, boundaries, tuning), counts = pattern !== 'large' && options.lobes && options.pattern !== 'mixed' ? [options.lobes] : pattern === 'large' ? [1, 2, 3, 4, 6, 8] : [4, 6, 8, 2, 3, 1];
	for (const count of counts) {
		if (tuning.pattern === 'double' && count < 2) continue;
		let lo = Math.max(2 * radius, pattern === 'large' ? 0 : options.minAmplitude ?? 0), hi = options.amplitude;
		if (hi < lo || profileExtra(new Array(count).fill(lo), tuning, virtualWidth) > extra || profileExtra(new Array(count).fill(hi), tuning, virtualWidth) < extra) continue;
		for (let k = 0; k < 45; k++) { const a = (lo + hi) / 2; if (profileExtra(new Array(count).fill(a), tuning, virtualWidth) < extra) lo = a; else hi = a; }
		const amplitudes = new Array(count).fill((lo + hi) / 2), span = (tuning.pattern === 'double' ? count : 2 * count - 1) * tuning.pitch + 2 * radius, guard = radius + options.clearance;
		const room = copperLength(spine) - 2 * guard - span; if (room < 0) continue;
		const jobs = [.5, 0, 1, .25, .75].flatMap(f => (options.side === 'left' ? [1] : options.side === 'right' ? [-1] : [1, -1]).map(sign => ({ first: guard + radius + room * f, sign, score: priority(spine, guard + room * f, span, tuning.pattern, sign) }))).filter(w => Number.isFinite(w.score)).sort((a, b) => b.score - a.score);
		for (const job of jobs) {
			yield `正在检查差分对共同${pattern === 'large' ? '紧凑折返' : '蛇形'}，保留主干中心距 ${pair.spacing.toFixed(3)}mil…`;
			const wave = profileGeometry(spine, amplitudes, tuning, job.first, job.sign), groups: Line[][] = [];
			for (let i = 0; i < 2; i++) {
				const source = pair.sources[i], across = source.start.x * pair.normal.x + source.start.y * pair.normal.y;
				let offset = offsetPath(wave, across - pair.middle); if (!offset) break;
				const forward = (source.end.x - source.start.x) * pair.u.x + (source.end.y - source.start.y) * pair.u.y > 0;
				if (!forward) offset = offset.reverse().map(l => ({ ...l, start: l.end, end: l.start, ...(l.arcAngle ? { arcAngle: -l.arcAngle } : {}) }));
				const pieces = [{ ...source, end: offset[0].start }, ...offset, { ...source, start: offset.at(-1)!.end }].filter(l => copperLength(l) > .001).map((l, j) => ({ ...l, id: j ? `${source.id}/length/differential/${j}` : source.id, net: source.net, width: source.width }));
				const route = chosen[i], index = route.lines.indexOf(source), previous = route.lines[index - 1], next = route.lines[index + 1];
				const touches = (p: Point, l?: Line) => !!l && Math.min(distance(p, l.start), distance(p, l.end)) < .001;
				const reversed = previous ? touches(source.end, previous) : touches(source.start, next);
				groups.push(route.lines.flatMap(l => l === source ? reversed ? [...pieces].reverse() : pieces : [l]));
			}
			if (groups.length !== 2 || !pairCoupled(groups, chosen.map(r => r.lines), pair)) continue;
			if (groups.some((group, i) => check(group, pair.sources[i], external.concat(groups[1 - i]), obstacles.filter(o => !(o.terminal && o.net === chosen[i].net)), boundaries, options.clearance, true, baseline))) continue;
			const rows = chosen.map((r, i) => { const before = total(r), after = groups[i].reduce((n, l) => n + copperLength(l), 0); return { id: r.id, net: r.net, before, after, added: after - before, error: after - target, segments: groups[i].length, styles: [pattern] }; });
			if (rows.some(r => Math.abs(r.error) > options.tolerance)) continue;
			return { lines: external.concat(groups.flat()), target, rows, groups, changed: 2, options: { ...options }, pushed: [], pushedPreview: [], sections: pair.sources.map((source, i) => ({ sourceId: source.id, pattern, added: rows[i].added, start: source.start, end: source.end, amplitudes })) };
		}
	}
	return undefined;
}
