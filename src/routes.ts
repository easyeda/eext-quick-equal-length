import type { Line, Point } from './geometry';
import type { Steps } from './work';
import { finish } from './work';

export type SelectionScope = 'route' | 'segment';
export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export interface Obstacle { id: string; net: string; layer: number; box: Box; terminal?: boolean; pad?: boolean; arc?: boolean }
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
		if (anchor.terminal)
			groupedAnchors.set(anchor.net, [...(groupedAnchors.get(anchor.net) ?? []), anchor]);
	}
	for (const line of lines) {
		const group = `${line.layer}/${line.net}`;
		groupedLines.set(group, [...(groupedLines.get(group) ?? []), line]);
		for (const p of [line.start, line.end]) {
			const k = key(p, line);
			nodes.set(k, [...(nodes.get(k) ?? []), line]);
		}
		yield;
	}
	const atAnchor = (p: Point, l: Line) => (groupedAnchors.get(l.net) ?? []).filter(a => sameLayer(a.layer, l.layer)
		&& a.net === l.net && contains(a.box, p, EPS));
	const interiorBranch = (p: Point, l: Line) => groupedLines.get(`${l.layer}/${l.net}`)!.some(other => other.id !== l.id
		&& dist(p, other.start) > EPS && dist(p, other.end) > EPS && pointDistance(p, other.start, other.end) < EPS);
	const stop = (p: Point, l: Line) => nodes.get(key(p, l))!.length !== 2 || atAnchor(p, l).length > 0;
	const visited = new Set<string>();
	const routes: Route[] = [];
	function* walk(first: Line, start: Point): Steps<void> {
		const points = [start];
		const ordered: Line[] = [];
		let current = first;
		let point = start;
		let loop = false;
		while (!visited.has(current.id)) {
			visited.add(current.id);
			ordered.push(current);
			const end = dist(point, current.start) < EPS ? current.end : current.start;
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
		const blocked = ordered.some(l => [l.start, l.end].some(p => interiorBranch(p, l)))
			|| ordered.some(l => [l.start, l.end].some(p => atAnchor(p, l).some(a => a.arc)));
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

