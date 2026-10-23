import type { Line, Point } from './geometry';
import { copperBounds, copperBoxDistance, copperDistance } from './copper';
import type { Clearance, RuleObject } from './push-clearance';
import type { Steps } from './work';
import { analyze, planSpacing } from './geometry';
import { clearanceGap, clearanceStep } from './push-clearance';
import { finish } from './work';

export type SelectionScope = 'route' | 'segment';
export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export interface Obstacle { id: string; net: string; layer: number; box: Box; terminal?: boolean; arc?: boolean; kind?: RuleObject }
export interface Route {
	id: string;
	net: string;
	layer: number;
	lines: Line[];
	points: Point[];
	fixedStart: boolean;
	fixedEnd: boolean;
	locked: boolean;
	unsupported: boolean;
}
export interface LineChange { before?: Line; after: Line }
export interface RoutePlan { route: Route; points: Point[]; pushed: boolean; unchanged?: boolean; pieces?: LineChange[] }
const EPS = 0.001;
export const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a: Point, s: number): Point => ({ x: a.x * s, y: a.y * s });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const key = (p: Point, l: Line) => `${l.net}/${l.layer}/${p.x.toFixed(3)}/${p.y.toFixed(3)}`;
const sameLayer = (a: number, b: number) => a === b || a === 12 || b === 12;
const sameNet = (a: string, b: string) => !!a && a === b;

export function outlinePoints(source: (string | number)[]): Point[] {
	if (source[0] === 'R') {
		const [, x, y, w, h, rotation, round] = source.map((v, i) => i ? Number(v) : v) as [string, number, number, number, number, number, number];
		if (rotation !== 0 || ![x, y, w, h, round].every(Number.isFinite) || w <= 0 || h <= 0)
			throw new Error('当前板框矩形参数不支持，不能执行推挤');
		const r = Math.min(Math.max(0, round), w / 2, h / 2);
		if (!r)
			return [{ x, y }, { x: x + w, y }, { x: x + w, y: y - h }, { x, y: y - h }];
		const n = Math.max(4, Math.ceil(Math.PI / 2 / (2 * Math.acos(1 - Math.min(0.1 / r, 1)))));
		const centers = [{ x: x + r, y: y - r }, { x: x + w - r, y: y - r }, { x: x + w - r, y: y - h + r }, { x: x + r, y: y - h + r }];
		return centers.flatMap((c, corner) => Array.from({ length: n + 1 }, (_, j) => {
			const angle = Math.PI - corner * Math.PI / 2 - j * Math.PI / 2 / n;
			return { x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) };
		}));
	}
	const values = source.filter(v => v !== 'L');
	if (values.some(v => typeof v !== 'number' || !Number.isFinite(v)) || values.length < 6 || values.length % 2)
		throw new Error('当前板框含暂不支持的曲线指令，不能执行推挤');
	return Array.from({ length: values.length / 2 }, (_, i) => ({ x: Number(values[i * 2]), y: Number(values[i * 2 + 1]) }));
}

export function contains(box: Box, p: Point, padding = 0) {
	return p.x >= box.minX - padding && p.x <= box.maxX + padding && p.y >= box.minY - padding && p.y <= box.maxY + padding;
}

export function pointDistance(p: Point, a: Point, b: Point) {
	const v = sub(b, a);
	const t = Math.max(0, Math.min(1, dot(sub(p, a), v) / (dot(v, v) || 1)));
	return dist(p, add(a, mul(v, t)));
}

export function segmentDistance(a: Point, b: Point, c: Point, d: Point) {
	const ab = sub(b, a);
	const cd = sub(d, c);
	const denominator = cross(ab, cd);
	if (Math.abs(denominator) > 1e-10) {
		const t = cross(sub(c, a), cd) / denominator;
		const u = cross(sub(c, a), ab) / denominator;
		if (t >= 0 && t <= 1 && u >= 0 && u <= 1)
			return 0;
	}
	return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b));
}

export function touchesBox(a: Point, b: Point, box: Box, padding = 0) {
	const expanded = { minX: box.minX - padding, maxX: box.maxX + padding, minY: box.minY - padding, maxY: box.maxY + padding };
	if (contains(expanded, a) || contains(expanded, b))
		return true;
	const corners = [
		{ x: expanded.minX, y: expanded.minY },
		{ x: expanded.maxX, y: expanded.minY },
		{ x: expanded.maxX, y: expanded.maxY },
		{ x: expanded.minX, y: expanded.maxY },
	];
	return corners.some((p, i) => segmentDistance(a, b, p, corners[(i + 1) % 4]) < EPS);
}

export function buildRoutes(lines: Line[], anchors: Obstacle[]): Route[] {
	return finish(buildRoutesSteps(lines, anchors));
}

export function* buildRoutesSteps(lines: Line[], anchors: Obstacle[]): Steps<Route[]> {
	const nodes = new Map<string, Line[]>();
	const groupedLines = new Map<string, Line[]>();
	const groupedAnchors = new Map<string, Obstacle[]>();
	for (const anchor of anchors) {
		if (anchor.terminal) {
			if (!groupedAnchors.has(anchor.net))
				groupedAnchors.set(anchor.net, []);
			groupedAnchors.get(anchor.net)!.push(anchor);
		}
	}
	for (const line of lines) {
		const group = `${line.layer}/${line.net}`;
		if (!groupedLines.has(group))
			groupedLines.set(group, []);
		groupedLines.get(group)!.push(line);
		for (const p of [line.start, line.end]) {
			const k = key(p, line);
			nodes.set(k, [...(nodes.get(k) ?? []), line]);
		}
		yield;
	}
	const anchorCache = new Map<string, Obstacle[]>();
	const branchCache = new Map<string, boolean>();
	const atAnchor = (p: Point, l: Line) => {
		const node = key(p, l);
		if (!anchorCache.has(node))
			anchorCache.set(node, (groupedAnchors.get(l.net) ?? []).filter(a => sameLayer(a.layer, l.layer) && contains(a.box, p, EPS)));
		return anchorCache.get(node)!;
	};
	const interiorBranch = (p: Point, l: Line) => {
		const node = key(p, l);
		if (!branchCache.has(node)) {
			branchCache.set(node, groupedLines.get(`${l.layer}/${l.net}`)!.some(other => other.id !== l.id
				&& dist(p, other.start) > EPS && dist(p, other.end) > EPS && pointDistance(p, other.start, other.end) < EPS));
		}
		return branchCache.get(node)!;
	};
	const stop = (p: Point, l: Line) => nodes.get(key(p, l))!.length !== 2 || atAnchor(p, l).length > 0;
	const visited = new Set<string>();
	const routes: Route[] = [];
	function* walk(first: Line, start: Point): Steps<void> {
		const points = [start];
		const ordered: Line[] = [];
		let current = first;
		let point = start;
		let loop = false;
		let blocked = false;
		while (!visited.has(current.id)) {
			visited.add(current.id);
			ordered.push(current);
			const end = dist(point, current.start) < EPS ? current.end : current.start;
			blocked ||= [point, end].some(p => interiorBranch(p, current) || atAnchor(p, current).some(a => a.arc));
			points.push(end);
			if (stop(end, current))
				break;
			const next = nodes.get(key(end, current))!.find(l => l.id !== current.id)!;
			if (visited.has(next.id)) {
				loop = true;
				break;
			}
			point = end;
			current = next;
			yield;
		}
		const last = ordered[ordered.length - 1];
		const fixed = (p: Point, line: Line) => nodes.get(key(p, line))!.length > 1 || atAnchor(p, line).length > 0 || interiorBranch(p, line);
		routes.push({ id: ordered.map(l => l.id).sort().join('|'), net: first.net, layer: first.layer, lines: ordered, points, fixedStart: fixed(start, first), fixedEnd: fixed(points[points.length - 1], last), locked: ordered.some(l => l.locked), unsupported: loop || blocked });
	}
	for (const line of lines) {
		if (visited.has(line.id))
			continue;
		if (stop(line.start, line))
			yield* walk(line, line.start);
		else if (stop(line.end, line))
			yield* walk(line, line.end);
		yield;
	}
	for (const line of lines) {
		if (!visited.has(line.id))
			yield* walk(line, line.start);
	}
	return routes;
}

function simplify(points: Point[]) {
	const result: Point[] = [];
	for (const point of points) {
		if (!result.length || dist(point, result[result.length - 1]) > EPS)
			result.push({ ...point });
	}
	for (let i = result.length - 2; i > 0; i--) {
		const a = sub(result[i], result[i - 1]);
		const b = sub(result[i + 1], result[i]);
		if (Math.abs(cross(a, b)) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) < 1e-8 && dot(a, b) > 0)
			result.splice(i, 1);
	}
	return result;
}

export function offsetPath(points: Point[], distance: number): Point[] {
	const clean = simplify(points);
	if (clean.length < 2)
		throw new Error('路径过短或包含零长度线段');
	const directions = clean.slice(1).map((p, i) => mul(sub(p, clean[i]), 1 / dist(p, clean[i])));
	const normals = directions.map(v => ({ x: -v.y, y: v.x }));
	const result = [add(clean[0], mul(normals[0], distance))];
	for (let i = 1; i < clean.length - 1; i++) {
		const a = add(clean[i], mul(normals[i - 1], distance));
		const b = add(clean[i], mul(normals[i], distance));
		const denominator = cross(directions[i - 1], directions[i]);
		if (Math.abs(denominator) < 1e-8) {
			if (dot(directions[i - 1], directions[i]) < 0)
				throw new Error('路径包含折返，无法建立偏移路径');
			result.push(a);
		}
		else {
			const joint = add(a, mul(directions[i - 1], cross(sub(b, a), directions[i]) / denominator));
			if (dist(joint, clean[i]) > Math.max(1, Math.abs(distance) * 12))
				throw new Error('路径转角过尖，偏移后无法形成稳定连接');
			result.push(joint);
		}
	}
	result.push(add(clean[clean.length - 1], mul(normals[normals.length - 1], distance)));
	return result;
}

function withAnchors(route: Route, points: Point[]) {
	points = points.map(p => ({ ...p }));
	if (route.fixedStart)
		points[0] = taperToAnchor(route.points[0], points[0], points[1], true);
	if (route.fixedEnd) {
		const i = points.length - 2;
		points[i + 1] = taperToAnchor(route.points[route.points.length - 1], points[i], points[i + 1], false);
	}
	const path = simplify([
		...(route.fixedStart ? [route.points[0]] : []),
		...points,
		...(route.fixedEnd ? [route.points[route.points.length - 1]] : []),
	]);
	// Never remove original primitive IDs: extra vertices subdivide straight segments if needed.
	while (path.length - 1 < route.lines.length) {
		let longest = 0;
		for (let i = 1; i < path.length - 1; i++) {
			if (dist(path[i], path[i + 1]) > dist(path[longest], path[longest + 1]))
				longest = i;
		}
		path.splice(longest + 1, 0, mul(add(path[longest], path[longest + 1]), 0.5));
	}
	validatePath(path);
	return path;
}

function taperToAnchor(anchor: Point, start: Point, end: Point, atStart: boolean): Point {
	const length = dist(start, end);
	if (length < EPS)
		throw new Error('连接段长度不足，未提交');
	const direction = mul(sub(end, start), 1 / length);
	const projection = add(start, mul(direction, dot(sub(anchor, start), direction)));
	const offset = dist(anchor, projection);
	const joint = add(projection, mul(direction, atStart ? offset : -offset));
	if ((atStart ? dot(sub(end, joint), direction) : dot(sub(joint, start), direction)) < EPS)
		throw new Error('没有足够空间形成 45° 连接，请减小间距，未提交');
	return joint;
}

function validatePath(path: Point[]) {
	if (path.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
		throw new Error('路径坐标异常，未提交');
	for (let i = 0; i < path.length - 1; i++) {
		if (dist(path[i], path[i + 1]) < EPS)
			throw new Error('偏移后出现零长度路径');
		if (i + 2 < path.length) {
			const a = sub(path[i + 1], path[i]);
			const b = sub(path[i + 2], path[i + 1]);
			if (dot(a, b) < -1e-8 * Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y))
				throw new Error('连接产生锐角或折返，请减小间距，未提交');
		}
		for (let j = i + 2; j < path.length - 1; j++) {
			if (segmentDistance(path[i], path[i + 1], path[j], path[j + 1]) < EPS)
				throw new Error('偏移后路径自身相交，未提交');
		}
	}
}

function width(route: Route) {
	return Math.max(...route.lines.map(l => l.width));
}

const pieceCache = new WeakMap<RoutePlan, LineChange[]>();
const boundsCache = new WeakMap<Line, Box>();
const staticPlans = new WeakMap<Route, RoutePlan>();

function staticPlan(route: Route): RoutePlan {
	let plan = staticPlans.get(route);
	if (!plan) {
		plan = { route, points: route.points, pushed: false, unchanged: true };
		staticPlans.set(route, plan);
	}
	return plan;
}

function collisionPieces(plan: RoutePlan): LineChange[] {
	let pieces = pieceCache.get(plan);
	if (!pieces) {
		pieces = plan.unchanged || plan.points === plan.route.points
			? plan.route.lines.map(line => ({ before: line, after: line }))
			: materialize(plan);
		pieceCache.set(plan, pieces);
	}
	return pieces;
}

function bounds(line: Line): Box {
	let box = boundsCache.get(line);
	if (!box) {
		box = copperBounds(line);
		boundsCache.set(line, box);
	}
	return box;
}

function nearBoxes(a: Box, b: Box, gap: number) {
	return a.minX <= b.maxX + gap && b.minX <= a.maxX + gap && a.minY <= b.maxY + gap && b.minY <= a.maxY + gap;
}

function collision(a: RoutePlan, b: RoutePlan, clearance: Clearance) {
	if (a.route.layer !== b.route.layer || sameNet(a.route.net, b.route.net))
		return false;
	return collisionPieces(a).some(left => collisionPieces(b).some((right) => {
		const required = clearanceGap(clearance, left.after, right.after);
		if (!nearBoxes(bounds(left.after), bounds(right.after), required + (left.after.width + right.after.width) / 2))
			return false;
		const gap = copperDistance(left.after, right.after) - (left.after.width + right.after.width) / 2;
		if (gap >= required - EPS)
			return false;
		const oldGap = left.before && right.before
			? copperDistance(left.before, right.before) - (left.before.width + right.before.width) / 2
			: Infinity;
		return gap < oldGap - EPS;
	}));
}

function boxDistance(a: Point, b: Point, box: Box) {
	if (contains(box, a) || contains(box, b))
		return 0;
	const corners = [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
	return Math.min(...corners.map((p, i) => segmentDistance(a, b, p, corners[(i + 1) % 4])));
}

function hardCollision(plan: RoutePlan, obstacles: Obstacle[], boundaries: Line[], clearance: Clearance): string | undefined {
	for (const { before, after } of collisionPieces(plan)) {
		for (const obstacle of obstacles) {
			if (!sameLayer(obstacle.layer, after.layer) || sameNet(obstacle.net, after.net))
				continue;
			const required = clearanceGap(clearance, after, obstacle, obstacle.kind ?? 'Track');
			if (!nearBoxes(bounds(after), obstacle.box, required + after.width / 2))
				continue;
			const gap = copperBoxDistance(after, obstacle.box) - after.width / 2;
			const oldGap = before ? copperBoxDistance(before, obstacle.box) - before.width / 2 : Infinity;
			if (gap < required - EPS && gap < oldGap - EPS)
				return `与固定铜障碍（${obstacle.net || obstacle.id}）净距不足`;
		}
		for (const edge of boundaries) {
			const required = clearanceGap(clearance, after, edge, 'Board Outline');
			if (!nearBoxes(bounds(after), bounds(edge), required + after.width / 2))
				continue;
			const gap = copperDistance(after, edge) - after.width / 2;
			const oldGap = before ? copperDistance(before, edge) - before.width / 2 : Infinity;
			if (gap < required - EPS && gap < oldGap - EPS)
				return '与板边净距不足';
		}
	}
	return undefined;
}

export function selectRoutes(routes: Route[], region?: Box, ids?: string[]) {
	const set = new Set(ids ?? []);
	const chosen = routes.filter(r => r.lines.some(l => region ? touchesBox(l.start, l.end, region, l.width / 2) : set.has(l.id)));
	if (chosen.length < 2)
		throw new Error('请圈定至少两条完整走线');
	if (chosen.some(r => r.locked))
		throw new Error('目标路径含锁定线段，请先解锁');
	if (chosen.some(r => r.unsupported))
		throw new Error('目标含闭环、圆弧连接或线段中部 T 连接，暂不调整');
	if (chosen.some(r => r.layer !== chosen[0].layer))
		throw new Error('区域涉及多个铜层，请缩小区域或改用选中集读取');
	return chosen;
}

function segmentRoute(line: Line): Route {
	return { id: `segment/${line.id}`, net: line.net, layer: line.layer, lines: [line], points: [line.start, line.end], fixedStart: false, fixedEnd: false, locked: line.locked, unsupported: false };
}

export function selectSegments(lines: Line[], region?: Box, ids?: string[]): Route[] {
	const set = new Set(ids ?? []);
	const chosen = lines.filter(l => region ? touchesBox(l.start, l.end, region, l.width / 2) : set.has(l.id));
	analyze(chosen);
	return chosen.map(segmentRoute);
}

export function planSegments(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[] = [], boundaries: Line[] = []): RoutePlan[] {
	return finish(planSegmentsSteps(routes, selected, spacing, mode, clearance, obstacles, boundaries));
}

export function* planSegmentsSteps(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[] = [], boundaries: Line[] = []): Steps<RoutePlan[]> {
	if (!Number.isFinite(clearanceStep(clearance)) || clearanceStep(clearance) < 0)
		throw new Error('避让净距不得小于 0');
	if (selected.some(r => r.lines.length !== 1))
		throw new Error('线段模式需要重新读取独立线段');
	const selectedLines = selected.map(r => r.lines[0]);
	const initial = planSpacing(selectedLines, spacing);
	const { normal, offsets } = analyze(selectedLines);
	const ids = new Set(selectedLines.map(l => l.id));
	const affected = routes.filter(r => r.lines.some(l => ids.has(l.id)));
	if (selectedLines.some(l => !affected.some(r => r.lines.some(s => s.id === l.id))))
		throw new Error('无法找到线段的原有连接路径，请重新读取');
	const remaining = routes.filter(r => !affected.includes(r));
	const center = offsets.reduce((sum, offset) => sum + offset, 0) / offsets.length - offsets[0] - spacing * (offsets.length - 1) / 2;
	// Widen a bundle into both sides. If blocked, move the whole bundle while
	// keeping the requested pitch and the original transverse order unchanged.
	const preferred = selectedLines.length > 2 ? center : 0;
	const bases = [preferred];
	if (mode === 'push') {
		bases.push(center, 0, 2 * center);
		const step = Math.max(2, clearanceStep(clearance) + Math.max(...selectedLines.map(l => l.width)));
		for (let n = 1; n <= 16; n++)
			bases.push(center - n * step, center + n * step);
	}
	let failure: unknown;
	const tried = new Set<number>();
	for (const base of bases) {
		yield '正在搜索等距位置…';
		const rounded = Math.round(base / EPS);
		if (tried.has(rounded))
			continue;
		tried.add(rounded);
		try {
			const shifts = new Map(initial.map(({ before, after }) => {
				const delta = mul(normal, base);
				const target = { ...after, start: add(after.start, delta), end: add(after.end, delta) };
				return [before.id, { after: target, moved: dist(before.start, target.start) > 1e-7 }];
			}));
			const plans = new Map(affected.map(route => [route.id, planSegmentRoute(route, shifts)]));
			return yield* resolvePlansSteps(remaining, plans, mode, clearance, obstacles, boundaries);
		}
		catch (error) {
			failure ??= error;
		}
	}
	throw failure;
}

interface Segment { start: Point; end: Point }

function intersection(a: Segment, b: Segment): Point | undefined {
	const av = sub(a.end, a.start);
	const bv = sub(b.end, b.start);
	const denominator = cross(av, bv);
	if (Math.abs(denominator) / (dist(a.start, a.end) * dist(b.start, b.end)) < 1e-8)
		return undefined;
	return add(a.start, mul(av, cross(sub(b.start, a.start), bv) / denominator));
}

function stretchCollinearRun(route: Route, segments: Segment[], shifts: Map<string, { after: Line; moved: boolean }>, joint: number, leftSelected: boolean, point: Point): boolean {
	const selected = leftSelected ? joint - 1 : joint;
	const neighbor = leftSelected ? joint : joint - 1;
	const direction = sub(route.points[neighbor + 1], route.points[neighbor]);
	const advance = leftSelected ? 1 : -1;
	let far = neighbor;
	while (far + advance >= 0 && far + advance < segments.length) {
		const next = far + advance;
		const vector = sub(route.points[next + 1], route.points[next]);
		if (route.lines[next].locked || shifts.has(route.lines[next].id)
			|| dot(direction, vector) <= 0 || Math.abs(cross(direction, vector)) > 1e-8 * Math.hypot(direction.x, direction.y) * Math.hypot(vector.x, vector.y)) {
			break;
		}
		far = next;
	}
	if (far === neighbor)
		return false;
	const start = leftSelected ? point : segments[far].start;
	const end = leftSelected ? segments[far].end : point;
	const selectedStart = leftSelected ? segments[selected].start : point;
	const selectedEnd = leftSelected ? point : segments[selected].end;
	const selectedDirection = sub(route.points[selected + 1], route.points[selected]);
	if (dot(sub(end, start), direction) <= EPS * Math.hypot(direction.x, direction.y)
		|| dot(sub(selectedEnd, selectedStart), selectedDirection) <= EPS * Math.hypot(selectedDirection.x, selectedDirection.y)) {
		return false;
	}
	const first = Math.min(neighbor, far);
	const last = Math.max(neighbor, far);
	const lengths = route.lines.slice(first, last + 1).map((_, i) => dist(route.points[first + i], route.points[first + i + 1]));
	const total = lengths.reduce((sum, length) => sum + length, 0);
	if (lengths.some(length => dist(start, end) * length / total <= EPS))
		return false;
	// Native copper may subdivide one straight diagonal into several IDs.
	// Redistribute its internal vertices instead of turning an exhausted piece back.
	let used = 0;
	for (let i = first; i <= last; i++) {
		const a = add(start, mul(sub(end, start), used / total));
		used += lengths[i - first];
		segments[i] = { start: a, end: i === last ? end : add(start, mul(sub(end, start), used / total)) };
	}
	segments[selected] = { start: selectedStart, end: selectedEnd };
	return true;
}

function slideBend(route: Route, segments: Segment[], shifts: Map<string, { after: Line; moved: boolean }>, joint: number, leftSelected: boolean): boolean {
	const selected = leftSelected ? joint - 1 : joint;
	const neighbor = leftSelected ? joint : joint - 1;
	const outer = leftSelected ? joint + 1 : joint - 2;
	if (outer < 0 || outer >= segments.length || route.lines[outer].locked || shifts.has(route.lines[outer].id))
		return false;
	const step = shifts.get(route.lines[selected].id)!;
	const delta = sub(step.after.start, route.lines[selected].start);
	const moved = { start: add(route.points[neighbor], delta), end: add(route.points[neighbor + 1], delta) };
	const near = intersection(segments[selected], moved);
	const far = intersection(moved, segments[outer]);
	if (!near || !far)
		return false;
	const trial = new Map<number, Segment>();
	trial.set(selected, leftSelected ? { ...segments[selected], end: near } : { ...segments[selected], start: near });
	trial.set(neighbor, leftSelected ? { start: near, end: far } : { start: far, end: near });
	trial.set(outer, leftSelected ? { ...segments[outer], start: far } : { ...segments[outer], end: far });
	for (const [index, line] of trial) {
		const direction = sub(route.points[index + 1], route.points[index]);
		if (dot(sub(line.end, line.start), direction) <= EPS * Math.hypot(direction.x, direction.y))
			return false;
	}
	for (const [index, line] of trial)
		segments[index] = line;
	return true;
}

export function planSegmentRoute(route: Route, shifts: Map<string, { after: Line; moved: boolean }>): RoutePlan {
	if (!route.lines.some(l => shifts.get(l.id)?.moved)) {
		return { route, points: route.points, pushed: false, unchanged: true };
	}
	if (route.unsupported)
		throw new Error('目标连接闭环、圆弧或中部 T 节点，无法保持连接，未提交');
	const segments = route.lines.map((line, i) => {
		const step = shifts.get(line.id);
		const a = step?.after ?? line;
		const forward = dist(line.start, route.points[i]) < EPS;
		return { start: { ...(forward ? a.start : a.end) }, end: { ...(forward ? a.end : a.start) } };
	});
	const reshaped = new Set<string>();
	for (let i = 1; i < segments.length; i++) {
		const leftSelected = shifts.has(route.lines[i - 1].id);
		const rightSelected = shifts.has(route.lines[i].id);
		if (leftSelected === rightSelected)
			continue;
		const neighbor = leftSelected ? route.lines[i] : route.lines[i - 1];
		if (neighbor.locked)
			continue; // Keep a locked neighbor fixed and bridge back to its original endpoint.
		const left = segments[i - 1];
		const right = segments[i];
		const a = sub(left.end, left.start);
		const b = sub(right.end, right.start);
		const denominator = cross(a, b);
		if (Math.abs(denominator) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) < 1e-8)
			continue;
		const joint = add(left.start, mul(a, cross(sub(right.start, left.start), b) / denominator));
		const displacement = Math.max(dist(left.end, route.points[i]), dist(right.start, route.points[i]));
		if (dist(joint, route.points[i]) > Math.max(1, displacement * 12))
			throw new Error('原连接角度过尖，无法自然衔接，未提交');
		const leftDirection = sub(route.points[i], route.points[i - 1]);
		const rightDirection = sub(route.points[i + 1], route.points[i]);
		if (dot(sub(joint, left.start), leftDirection) <= EPS * Math.hypot(leftDirection.x, leftDirection.y)
			|| dot(sub(right.end, joint), rightDirection) <= EPS * Math.hypot(rightDirection.x, rightDirection.y)) {
			if (stretchCollinearRun(route, segments, shifts, i, leftSelected, joint))
				continue;
			// Keep a short bend pointing forwards by sliding its far vertex along
			// the next support. The distant pad/via endpoint stays fixed.
			if (slideBend(route, segments, shifts, i, leftSelected))
				continue;
			// The original diagonal may run out of length. Rebuild that diagonal
			// from its fixed far vertex into a clean 45-degree join, without a stub.
			if (leftSelected) {
				left.end = taperToAnchor(right.end, left.start, left.end, false);
				right.start = left.end;
			}
			else {
				right.start = taperToAnchor(left.start, right.start, right.end, true);
				left.end = right.start;
			}
			reshaped.add(neighbor.id);
			continue;
		}
		left.end = joint;
		right.start = joint;
	}
	// A fixed/parallel neighbor can only be joined by trimming the selected
	// support into a forward 45-degree transition. Never append a perpendicular stub.
	for (let i = 1; i < segments.length; i++) {
		const left = segments[i - 1];
		const right = segments[i];
		if (dist(left.end, right.start) <= EPS)
			continue;
		const leftSelected = shifts.has(route.lines[i - 1].id);
		const rightSelected = shifts.has(route.lines[i].id);
		if (leftSelected === rightSelected)
			throw new Error('相邻所选段无法自然衔接，请重新取区，未提交');
		if (leftSelected)
			left.end = taperToAnchor(right.start, left.start, left.end, false);
		else
			right.start = taperToAnchor(left.end, right.start, right.end, true);
	}
	if (route.fixedStart)
		segments[0].start = taperToAnchor(route.points[0], segments[0].start, segments[0].end, true);
	if (route.fixedEnd) {
		const last = segments[segments.length - 1];
		last.end = taperToAnchor(route.points[route.points.length - 1], last.start, last.end, false);
	}
	const points: Point[] = [];
	const pieces: LineChange[] = [];
	const bridge = (from: Point, to: Point, source: Line) => {
		if (dist(from, to) <= EPS)
			return;
		pieces.push({ after: { ...source, id: '', start: from, end: to, locked: false } });
		points.push(to);
	};
	points.push(route.fixedStart ? route.points[0] : segments[0].start);
	bridge(points[0], segments[0].start, route.lines[0]);
	for (let i = 0; i < segments.length; i++) {
		const before = route.lines[i];
		const { start, end } = segments[i];
		if (!reshaped.has(before.id) && dot(sub(end, start), sub(route.points[i + 1], route.points[i])) <= EPS * dist(route.points[i + 1], route.points[i]))
			throw new Error('间距导致连接段消失或折返，无法保持连接，未提交');
		bridge(points[points.length - 1], start, shifts.has(before.id) ? before : route.lines[i - 1]);
		const forward = dist(before.start, route.points[i]) < EPS;
		const after = { ...before, start: forward ? start : end, end: forward ? end : start };
		pieces.push({ before, after });
		points.push(end);
	}
	if (route.fixedEnd)
		bridge(points[points.length - 1], route.points[route.points.length - 1], route.lines[route.lines.length - 1]);
	validatePath(points);
	return { route, points, pushed: false, pieces };
}

export function planRoutes(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance,	obstacles: Obstacle[] = [], boundaries: Line[] = []): RoutePlan[] {
	return finish(planRoutesSteps(routes, selected, spacing, mode, clearance, obstacles, boundaries));
}

export function* planRoutesSteps(routes: Route[], selected: Route[], spacing: number, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[] = [], boundaries: Line[] = []): Steps<RoutePlan[]> {
	if (!Number.isFinite(spacing) || spacing <= 0 || !Number.isFinite(clearanceStep(clearance)) || clearanceStep(clearance) < 0)
		throw new Error('间距须大于 0，避让净距不得小于 0');
	if (selected.length < 2)
		throw new Error('至少需要两条目标路径');
	const longest = [...selected[0].lines].sort((a, b) => dist(b.start, b.end) - dist(a.start, a.end))[0];
	let tangent = mul(sub(longest.end, longest.start), 1 / dist(longest.start, longest.end));
	if (tangent.x < -EPS || (Math.abs(tangent.x) <= EPS && tangent.y < 0))
		tangent = mul(tangent, -1);
	let normal = { x: -tangent.y, y: tangent.x };
	if (Math.abs(normal.y) <= EPS && normal.x < 0)
		normal = mul(normal, -1);
	const position = (r: Route) => r.points.reduce((n, p) => n + dot(p, normal), 0) / r.points.length;
	const ordered = [...selected].sort((a, b) => position(a) - position(b));
	const reference = ordered[0];
	const base = simplify(reference.points);
	const axis = sub(base[1], base[0]);
	const sign = dot({ x: -axis.y, y: axis.x }, normal) < 0 ? -1 : 1;
	const plans = new Map<string, RoutePlan>();
	ordered.forEach((route, i) => {
		if (route.locked || route.unsupported)
			throw new Error('目标路径无法安全调整');
		if (!i) {
			plans.set(route.id, { route, points: route.points, pushed: false, unchanged: true });
			return;
		}
		let points = offsetPath(base, sign * spacing * i);
		const cost = (p: Point[]) => dist(p[0], route.points[0]) + dist(p[p.length - 1], route.points[route.points.length - 1]);
		if (cost([...points].reverse()) < cost(points))
			points = points.reverse();
		plans.set(route.id, { route, points: withAnchors(route, points), pushed: false });
	});
	return yield* resolvePlansSteps(routes, plans, mode, clearance, obstacles, boundaries);
}

export function* resolvePlansSteps(routes: Route[], plans: Map<string, RoutePlan>, mode: 'direct' | 'push', clearance: Clearance, obstacles: Obstacle[], boundaries: Line[]): Steps<RoutePlan[]> {
	if (mode === 'direct')
		return [...plans.values()];
	for (const a of plans.values()) {
		yield;
		const fixedConflict = hardCollision(a, obstacles, boundaries, clearance);
		if (fixedConflict)
			throw new Error(`走线 ${a.route.net || a.route.id} ${fixedConflict}，无法推挤`);
		for (const b of plans.values()) {
			if (a.route.id !== b.route.id && collision(a, b, clearance))
				throw new Error(`目标路径或固定端点之间的净距不足（${a.route.net} / ${b.route.net}）`);
		}
	}
	for (let cascade = 0; cascade < 64; cascade++) {
		let blocked: Route | undefined;
		for (const route of routes) {
			yield;
			if (!plans.has(route.id) && [...plans.values()].some(p => collision(p, staticPlan(route), clearance))) {
				blocked = route;
				break;
			}
		}
		if (!blocked)
			return [...plans.values()];
		if (blocked.locked || blocked.unsupported)
			throw new Error('推挤遇到锁定、闭环或不支持的连接路径，未提交');
		yield `正在推挤 ${blocked.net || '周围走线'}（${cascade + 1}）…`;
		let candidate: RoutePlan | undefined;
		const step = Math.max(2, clearanceStep(clearance) + width(blocked));
		const hitLines = blocked.lines.filter((line) => {
			const single = segmentRoute(line);
			return [...plans.values()].some(p => collision(p, staticPlan(single), clearance));
		}).sort((a, b) => dist(b.start, b.end) - dist(a.start, a.end));
		for (let n = 1; n <= 64 && !candidate; n++) {
			for (const side of [1, -1]) {
				yield;
				for (const line of hitLines) {
					yield;
					try {
						const direction = mul(sub(line.end, line.start), 1 / dist(line.start, line.end));
						const shift = mul({ x: -direction.y, y: direction.x }, side * n * step);
						const after = { ...line, start: add(line.start, shift), end: add(line.end, shift) };
						const trial = { ...planSegmentRoute(blocked, new Map([[line.id, { after, moved: true }]])), pushed: true };
						if (!hardCollision(trial, obstacles, boundaries, clearance)
							&& ![...plans.values()].some(p => collision(trial, p, clearance))) {
							candidate = trial;
							break;
						}
					}
					catch { /* Try a different local displacement before moving the complete path. */ }
				}
				if (candidate)
					break;
				try {
					const points = withAnchors(blocked, offsetPath(blocked.points, side * n * step));
					const trial = { route: blocked, points, pushed: true };
					if (!hardCollision(trial, obstacles, boundaries, clearance)
						&& ![...plans.values()].some(p => collision(trial, p, clearance))) {
						candidate = trial;
						break;
					}
				}
				catch { /* Try another bounded offset; no host mutation happens during search. */ }
			}
		}
		if (!candidate)
			throw new Error(`走线 ${blocked.net || blocked.id} 固定端点或周围空间不足，无法完成推挤，未提交`);
		plans.set(blocked.id, candidate);
	}
	throw new Error('推挤级联超过 64 条路径，未提交');
}

export function materialize(plan: RoutePlan): LineChange[] {
	if (plan.unchanged)
		return [];
	if (plan.pieces)
		return plan.pieces;
	return plan.points.slice(1).map((point, i) => ({
		before: plan.route.lines[i],
		after: { ...(plan.route.lines[i] ?? plan.route.lines[plan.route.lines.length - 1]), id: plan.route.lines[i]?.id ?? '', start: plan.points[i], end: point },
	}));
}
