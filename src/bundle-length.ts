import { is45Line } from './routing-direction';
import type { Line, Point } from './geometry';
import type { Route, Obstacle } from './routes';
import type { LengthOptions, LengthSection, TuningPattern } from './length-planner';
import type { Steps } from './work';
import { copperBounds, copperDistance, copperInterval, copperLength } from './copper';
import { profileExtra, profileGeometry } from './adaptive';
import { materialize, planSegmentRoute } from './push-routes';
import { createSpacePriority } from './space-priority';
import type { PlanningPolicy } from './differential';
import { pairCoupled } from './differential';

interface Candidate {
	group: Line[]; stems: Line[]; wave: Line[]; stemKey: number; key: number;
	section?: LengthSection;
	space?: number;
}
type Check = (candidate: Line[], source: Line, context: Line[], obstacles: Obstacle[], boundaries: Line[], clearance: number, self?: boolean, baseline?: ReadonlyMap<string, Line>) => string | undefined;
const EPS = .001;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const total = (route: Route) => route.lines.reduce((n, l) => n + copperLength(l), 0);
const longest = (route: Route) => [...route.lines].sort((a, b) => copperLength(b) - copperLength(a))[0];

// Keep traversal order even when a native primitive points against its route.
function replace(route: Route, source: Line, pieces: Line[]) {
	const index = route.lines.indexOf(source), previous = route.lines[index - 1], next = route.lines[index + 1];
	const touches = (p: Point, l?: Line) => !!l && Math.min(distance(p, l.start), distance(p, l.end)) < EPS;
	const reverse = previous ? touches(source.end, previous) : touches(source.start, next);
	return route.lines.flatMap(l => l === source ? (reverse ? [...pieces].reverse() : pieces) : [l]);
}

/** Jointly choose complete, already-matched paths; no chosen path is frozen early. */
export function* bundleLengthsSteps(lines: Line[], chosen: Route[], target: number, options: LengthOptions, obstacles: Obstacle[], boundaries: Line[], check: Check, policy: PlanningPolicy = {}): Steps<{ groups: Line[][]; sections: LengthSection[] } | undefined> {
	if (chosen.length < 2 || chosen.length > 12 || chosen.some(r => r.unsupported || r.locked || r.lines.some(l => l.layer !== r.layer))) return undefined;
	const reflowMatched = chosen.length === 2 && !policy.compactOnly && chosen.every(r => !r.id.startsWith('segment/'));
	const main = longest(chosen[0]);
	let ux = (main.end.x - main.start.x) / copperLength(main), uy = (main.end.y - main.start.y) / copperLength(main);
	if (ux < -EPS || (Math.abs(ux) < EPS && uy < 0)) { ux = -ux; uy = -uy; }
	const normal = { x: -uy, y: ux };
	if (chosen.some(r => { const l = longest(r); return Math.abs((l.end.x - l.start.x) * uy - (l.end.y - l.start.y) * ux) > EPS; })) return undefined;
	const position = (r: Route) => { const s = longest(r); return ((s.start.x + s.end.x) * normal.x + (s.start.y + s.end.y) * normal.y) / 2; };
	const ranked = [...chosen].sort((a, b) => position(b) - position(a));
	const used = new Set(chosen.filter(r => reflowMatched || target - total(r) > options.tolerance).flatMap(r => r.lines.map(l => l.id))), external = lines.filter(l => !used.has(l.id));
	const baseline = new Map(lines.map(l => [l.id, l]));
	const before = (l: Line) => baseline.get(l.id) ?? baseline.get(l.id.split('/length/')[0]);
	const domains: Candidate[][] = [];
	let stemSerial = 0;
	const patterns: TuningPattern[] = options.pattern === 'mixed' ? ['double'] : [options.pattern ?? 'large'];
	const step = Math.max(4, Math.max(...chosen.flatMap(r => r.lines.map(l => l.width + options.clearance))));
	for (let rank = 0; rank < ranked.length; rank++) {
		const route = ranked[rank], source = longest(route), delta = target - total(route);
		const segment = route.id.startsWith('segment/');
		yield `正在为 ${route.net} 生成可移动、保留接入点的等长候选（${rank + 1}/${ranked.length}）…`;
		const matched: Candidate[] = delta <= options.tolerance ? [{ group: route.lines, stems: route.lines, wave: [], stemKey: stemSerial++, key: 0, space: Number.MAX_SAFE_INTEGER }] : [];
		if (matched.length && !reflowMatched) { domains.push(matched); continue; }
		const ownObstacles = obstacles.filter(o => !(o.terminal && o.net === route.net));
		const priority = createSpacePriority(external, ownObstacles, boundaries, options);
		const amplitudeProfiles = new Map<string, number[]>();
		const plannedWaves = new Map<string, Line[] | null>();
		const blockedStems = new WeakMap<Line, boolean>();
		const stemBlocked = (line: Line) => {
			let blocked = blockedStems.get(line);
			if (blocked === undefined) {
				const old = before(line);
				blocked = !old || !!check([line], old, external, ownObstacles, boundaries, options.clearance, false, baseline);
				blockedStems.set(line, blocked);
			}
			return blocked;
		};
		const variants: Route[] = [route];
		const orient = (pieces: Line[], aligned: boolean) => aligned ? pieces : segment ? [...pieces].reverse().map(l => ({ ...l, start: l.end, end: l.start, ...(l.arcAngle ? { arcAngle: -l.arcAngle } : {}) })) : [...pieces].reverse();
		if (reflowMatched && delta <= options.tolerance) for (const source of [...route.lines].filter(l => !l.arcAngle && copperLength(l) >= 3 * step).sort((a, b) => copperLength(b) - copperLength(a)).slice(0, 4)) {
			// Reuse equal-spacing style support translation and adjacent-line
			// intersections. Both source endpoints receive the same translation;
			// a different offset at either end would rotate the straight support.
			const offsets = [.25, .5, .625, .75, 1, 1.5, 2, 3].map(f => f * step).filter(s => s <= options.amplitude);
			const length = copperLength(source), dx = (source.end.x - source.start.x) / length, dy = (source.end.y - source.start.y) / length;
			const normal = dx < -EPS || (Math.abs(dx) < EPS && dy < 0) ? { x: dy, y: -dx } : { x: -dy, y: dx };
			for (const sign of options.side === 'left' ? [1] : options.side === 'right' ? [-1] : [1, -1]) for (const slide of offsets) {
				let shifted: Route;
				try {
					const after = { ...source, start: { x: source.start.x + normal.x * slide * sign, y: source.start.y + normal.y * slide * sign }, end: { x: source.end.x + normal.x * slide * sign, y: source.end.y + normal.y * slide * sign } };
					const moved = planSegmentRoute(route, new Map([[source.id, { after, moved: true }]])), pieces = materialize(moved).map(p => p.after);
					if (pieces.some(l => !is45Line(l)) || pieces.length !== route.lines.length || pieces.some(l => !l.id) || distance(moved.points[0], route.points[0]) > EPS || distance(moved.points.at(-1)!, route.points.at(-1)!) > EPS) continue;
					shifted = { ...route, lines: pieces, points: moved.points };
				} catch { continue; }
				const budget = target - total(shifted), support = shifted.lines.find(l => l.id === source.id)!;
				const stems = shifted.lines.filter(l => l !== support);
				if (stems.some(stemBlocked)) continue;
				if (Math.abs(budget) <= EPS) {
					if (!check([support], source, external, ownObstacles, boundaries, options.clearance, false, baseline) && !check(shifted.lines, source, [], [], [], options.clearance)) matched.push({ group: shifted.lines, stems: shifted.lines, wave: [], stemKey: stemSerial++, key: 0, space: priority.source(support) });
					continue;
				}
				yield;
			}
		}
		const slides = reflowMatched ? [0, .25, .5, .75, 1, 1.5, ...Array.from({ length: Math.max(2, Math.floor(options.amplitude / step)) - 1 }, (_, i) => i + 2)].map(f => f * step) : [0, step, 2 * step, 3 * step];
		for (const bothSides of policy.compactOnly ? [] : [false, true]) for (const direction of bothSides ? [1, -1] : [1]) for (const slide of bothSides ? [0] : slides) {
			let shifted = route;
			try {
				if (slide) {
					const after = { ...source, start: { x: source.start.x + normal.x * slide * direction, y: source.start.y + normal.y * slide * direction }, end: { x: source.end.x + normal.x * slide * direction, y: source.end.y + normal.y * slide * direction } };
					const moved = planSegmentRoute(route, new Map([[source.id, { after, moved: true }]]));
					const pieces = materialize(moved).map(p => p.after);
					if (pieces.some(l => !is45Line(l)) || pieces.length !== route.lines.length || pieces.some(l => !l.id) || distance(moved.points[0], route.points[0]) > EPS || distance(moved.points.at(-1)!, route.points.at(-1)!) > EPS) continue;
					shifted = { ...route, lines: pieces, points: moved.points }; variants.push(shifted);
				}
			} catch { continue; }
			const heights = Array.from({ length: 12 }, (_, i) => (i + 1.5) * step);
			if (bothSides && !heights.includes(options.amplitude)) heights.push(options.amplitude);
			if (segment) {
				// A short selected interval may only have a small amount of length
				// left after satisfying H and the requested wave count. Derive
				// small access-ramp heights from that budget instead of a 24mil grid.
				const pattern = patterns[0], count = options.lobes && pattern !== 'large' ? options.lobes : 4;
				const minimum = pattern === 'large' ? .2 : Math.max(.2, options.minAmplitude ?? 0);
				const spare = delta - profileExtra(new Array(count).fill(minimum), { ...options, pattern }, source.width);
				const cap = Math.min(options.amplitude, spare / (2 * (Math.SQRT2 - 1)));
				if (cap > .001) heights.push(...[.5, .75, .9, .975].map(f => cap * f));
			}
			heights.sort((a, b) => a - b);
			for (const height of heights.filter(h => h <= Math.min(2 * options.amplitude, 12.5 * step))) for (const guardBase of bothSides ? [step, 8 * step, 16 * step, 24 * step, 32 * step] : [step, 2.5 * step, 4 * step]) for (const reverseWindow of bothSides ? [false, true] : [false]) {
				const support = shifted.lines.find(l => l.id === source.id)!;
				const length = copperLength(support), aligned = (support.end.x - support.start.x) * ux + (support.end.y - support.start.y) * uy > 0;
				const start = aligned ? support.start : support.end, end = aligned ? support.end : support.start;
				const sideRank = direction > 0 ? rank : ranked.length - 1 - rank;
				const stagger = sideRank;
				const entryGuard = bothSides ? step + stagger * 2 * step : step + sideRank * step / 4;
				const exitGuard = bothSides ? guardBase + stagger * 3 * step : guardBase + sideRank * 3 * step / 4;
				const entry = reverseWindow ? exitGuard : entryGuard, exit = reverseWindow ? entryGuard : exitGuard;
				if (length - entry - exit - (bothSides ? step : 2 * height) < options.pitch) continue;
				const at = (x: number, y: number) => ({ x: start.x + ux * x + normal.x * y * direction, y: start.y + uy * x + normal.y * y * direction });
				const points = [start, at(entry, 0), at(entry + height, height), at(length - exit - height, height), at(length - exit, 0), end];
				const pieces = points.slice(1).map((end, i) => ({ ...support, id: i === 2 ? source.id : `${source.id}/length/reflow/${i}`, start: points[i], end }));
				if ((!bothSides || segment) && length - entry - exit - 2 * height >= options.pitch) variants.push({ ...shifted, lines: replace(shifted, support, orient(pieces, aligned)) });
				if (bothSides && height >= support.width + options.clearance) {
					// Rounded right-angle access ramps spend less lateral space on
					// the detour itself than two long diagonal ramps.
					const r = (support.width + options.clearance) / 2;
					const p = [at(entry - r, 0), at(entry, r), at(entry, height - r), at(entry + r, height), at(length - exit - r, height), at(length - exit, height - r), at(length - exit, r), at(length - exit + r, 0)];
					const vertices = [start, ...p, end];
					const rounded = vertices.slice(1).map((end, i) => ({ ...support, id: i === 4 ? source.id : `${source.id}/length/reflow/round/${i}`, start: vertices[i], end, ...(i % 2 === 1 ? { arcAngle: (i === 1 || i === 7 ? 90 : -90) * direction } : {}) }));
					variants.push({ ...shifted, lines: replace(shifted, support, orient(rounded, aligned)) });
				}
			}
		}
		const buckets: Candidate[][] = [], seen = new Set<string>();
		yield `正在测量 ${route.net} 周围空间，优先宽敞的区段和补长窗口…`;
		for (const variant of variants) {
			const extra = target - total(variant);
			if (extra <= EPS) continue;
			for (const support of variant.lines.filter(l => !l.arcAngle && copperLength(l) > options.pitch + 2 * (l.width + options.clearance)).sort((a, b) => priority.source(b) - priority.source(a)).slice(0, 8)) {
				const stems = variant.lines.filter(l => l !== support), stemKey = stemSerial++;
				if (stems.some(stemBlocked)) continue;
				const bucket: Candidate[] = [];
				for (const pattern of patterns) {
					const tuning = { ...options, pattern }, radius = (support.width + options.clearance) / 2, guard = support.width / 2 + options.clearance;
					const minimum = pattern === 'large' ? .2 : Math.max(.2, options.minAmplitude ?? 0);
					const counts = options.lobes && pattern !== 'large' ? [options.lobes] : [4];
					for (const count of counts) {
						if (count < 1 || (pattern === 'double' && count < 2)) continue;
						const span = pattern === 'double' ? count * options.pitch + 2 * radius : pattern === 'large' ? count * (options.pitch + 2 * radius) + (count - 1) * options.pitch : (2 * count - 1) * options.pitch + 2 * radius;
						const room = copperLength(support) - 2 * guard - span;
						if (room < 0) continue;
						for (const bias of options.dynamicAmplitude ? [0, .75, -.75] : [0]) {
							const profileKey = `${extra}/${support.width}/${pattern}/${count}/${bias}`;
							let amplitudes = amplitudeProfiles.get(profileKey);
							if (!amplitudes) {
								let lo = 0, hi = options.amplitude;
								const amplitudesAt = (x: number) => Array.from({ length: count }, (_, i) => minimum + x * (bias === 0 ? 1 : i % 2 === 0 ? 1 + bias : 1 - bias));
								for (let k = 0; k < 40; k++) { const x = (lo + hi) / 2; if (profileExtra(amplitudesAt(x), tuning, support.width) < extra) lo = x; else hi = x; }
								amplitudes = amplitudesAt((lo + hi) / 2); amplitudeProfiles.set(profileKey, amplitudes);
							}
							if (amplitudes.some(a => a > options.amplitude + EPS) || Math.abs(profileExtra(amplitudes, tuning, support.width) - extra) > EPS) continue;
							const windows = [.5, 0, 1, .25, .75].flatMap(fraction => (options.side === 'left' ? [1] : options.side === 'right' ? [-1] : [1, -1]).map(sign => ({ firstArm: guard + radius + room * fraction, sign, space: priority(support, guard + room * fraction, span, pattern, sign) }))).filter(w => Number.isFinite(w.space)).sort((a, b) => b.space - a.space);
							for (const { firstArm, sign, space } of windows) {
								const waveKey = JSON.stringify([support.id, support.width, support.start.x, support.start.y, support.end.x, support.end.y, pattern, amplitudes, firstArm, sign]);
								let wave = plannedWaves.get(waveKey);
								if (wave === undefined) {
									wave = profileGeometry(support, amplitudes, tuning, firstArm, sign);
									if (wave.some(l => copperLength(l) < EPS || !is45Line(l)) || check(wave, support, external, ownObstacles, boundaries, options.clearance, true, baseline)) wave = null;
									plannedWaves.set(waveKey, wave);
								}
								if (!wave) continue;
								const group = replace(variant, support, wave);
								if (check(group, support, [], [], [], options.clearance)) continue;
								const key = JSON.stringify(group.map(l => [l.start.x, l.start.y, l.end.x, l.end.y, l.arcAngle]));
								if (seen.has(key)) continue; seen.add(key);
								bucket.push({ group, stems, wave, stemKey, key: 0, space, section: { sourceId: source.id, pattern, added: extra, start: support.start, end: support.end, amplitudes } });
							}
						}
					}
				}
				if (bucket.length) buckets.push(bucket);
				yield;
			}
		}
		// Retain phase, side and amplitude diversity without a quadratic-sized domain.
		const domain: Candidate[] = [...matched];
		for (const bucket of buckets) {
			// Keep the most spacious candidate as well as phase/height diversity.
			const best = bucket.reduce((a, b) => (b.space ?? 0) > (a.space ?? 0) ? b : a);
			const sampled = new Set(Array.from({ length: Math.min(8, bucket.length) }, (_, k) => bucket[Math.floor(k * bucket.length / Math.min(8, bucket.length))]));
			sampled.add(best); domain.push(...sampled);
		}
		domain.sort((a, b) => (b.space ?? 0) - (a.space ?? 0));
		domain.forEach((c, key) => { c.key = key; });
		yield `${route.net} 可用候选：${domain.length}`; if (!domain.length) return undefined;
		domains.push(domain);
	}
	const groupBoxes = new WeakMap<Line[], ReturnType<typeof copperBounds>[]>();
	const boxes = (group: Line[]) => { let result = groupBoxes.get(group); if (!result) { result = group.map(copperBounds); groupBoxes.set(group, result); } return result; };
	const clearGroup = (left: Line[], right: Line[]) => {
		const leftBoxes = boxes(left), rightBoxes = boxes(right);
		for (let i = 0; i < left.length; i++) { const a = left[i], ab = leftBoxes[i]; for (let j = 0; j < right.length; j++) {
			const b = right[j], bb = rightBoxes[j], padding = options.clearance + (a.width + b.width) / 2;
			if (a.layer !== b.layer || ab.minX > bb.maxX + padding || bb.minX > ab.maxX + padding || ab.minY > bb.maxY + padding || bb.minY > ab.maxY + padding) continue;
			const gap = copperDistance(a, b) - (a.width + b.width) / 2;
			if (gap + EPS >= options.clearance) continue;
			const oldA = before(a), oldB = before(b);
			if (oldA && oldB && copperInterval(a, oldA) && copperInterval(b, oldB) && copperDistance(oldA, oldB) - (a.width + b.width) / 2 <= gap + EPS) continue;
			return false;
		} }
		return true;
	};
	const stemsCache = new Map<string, boolean>(), waveCache = new WeakMap<Line[], WeakMap<Line[], boolean>>();
	const waveClear = (wave: Line[], stems: Line[]) => { let map = waveCache.get(wave); if (!map) { map = new WeakMap(); waveCache.set(wave, map); } let value = map.get(stems); if (value === undefined) { value = clearGroup(wave, stems); map.set(stems, value); } return value; };
	const rows = domains.map(() => domains.map(() => new Map<number, Uint8Array>()));
	let operations = 0;
	const compatible = (i: number, a: Candidate, j: number, b: Candidate) => {
		let row = rows[i][j].get(a.key); if (!row) { row = new Uint8Array(domains[j].length); rows[i][j].set(a.key, row); }
		if (row[b.key]) return row[b.key] === 2;
		const key = `${i}/${a.stemKey}/${j}/${b.stemKey}`;
		let clear = stemsCache.get(key); if (clear === undefined) { clear = clearGroup(a.stems, b.stems); stemsCache.set(key, clear); }
		const result = clear && waveClear(a.wave, b.stems) && waveClear(b.wave, a.stems) && clearGroup(a.wave, b.wave) && (!policy.pair || pairCoupled([a.group, b.group], [ranked[i].lines, ranked[j].lines], policy.pair));
		row[b.key] = result ? 2 : 1; return result;
	};
	const available = domains.map(a => a.slice()), queue: [number, number][] = [];
	const active = domains.map(a => new Uint8Array(a.length).fill(1));
	const witnesses = domains.map(a => domains.map(() => new Int32Array(a.length).fill(-1)));
	const pending = domains.map(() => domains.map(() => false));
	const enqueue = (i: number, j: number) => { if (!pending[i][j]) { pending[i][j] = true; queue.push([i, j]); } };
	for (let i = 0; i < domains.length; i++) for (let j = 0; j < domains.length; j++) if (i !== j) enqueue(i, j);
	yield '正在联合筛选整组走线的主干、蛇形位置和振幅…';
	for (let at = 0; at < queue.length; at++) {
		// Propagate the smallest domains first, without changing candidate order.
		let first = at;
		for (let next = at + 1; next < queue.length; next++) if (available[queue[next][1]].length < available[queue[first][1]].length) first = next;
		[queue[at], queue[first]] = [queue[first], queue[at]];
		const [i, j] = queue[at], kept: Candidate[] = [];
		pending[i][j] = false;
		for (const a of available[i]) {
			const witness = witnesses[i][j][a.key];
			if (witness >= 0 && active[j][witness]) { kept.push(a); continue; }
			let supported = false;
			for (const b of available[j]) { if (++operations > 8000000) return undefined; if (operations % 2048 === 0) yield; if (compatible(i, a, j, b)) { supported = true; witnesses[i][j][a.key] = b.key; break; } }
			if (supported) kept.push(a);
			else active[i][a.key] = 0;
		}
		if (kept.length !== available[i].length) { available[i] = kept; if (!kept.length) { yield `无兼容候选 ${ranked[i].net}/${ranked[j].net}`; return undefined; } for (let k = 0; k < domains.length; k++) if (k !== i && k !== j) enqueue(k, i); }
	}
	function* solve(selected: Map<number, Candidate>, remaining: Candidate[][]): Steps<Map<number, Candidate> | undefined> {
		let index = -1;
		for (let i = 0; i < remaining.length; i++) if (!selected.has(i) && (index < 0 || remaining[i].length < remaining[index].length)) index = i;
		if (index < 0) return selected;
		for (const candidate of remaining[index]) {
			const next = remaining.map(a => a.slice()); let valid = true;
			for (let j = 0; j < next.length && valid; j++) if (j !== index && !selected.has(j)) {
				const kept: Candidate[] = [];
				for (const b of next[j]) { if (++operations > 8000000) return undefined; if (operations % 2048 === 0) yield; if (compatible(index, candidate, j, b)) kept.push(b); }
				next[j] = kept; valid = kept.length > 0;
			}
			if (!valid) continue;
			const found = yield* solve(new Map([...selected, [index, candidate]]), next); if (found) return found;
		}
		return undefined;
	}
	const solved = yield* solve(new Map(), available);
	if (!solved) return undefined;
	return { groups: chosen.map(r => solved.get(ranked.indexOf(r))!.group), sections: [...solved.values()].flatMap(c => c.section ? [c.section] : []) };
}












