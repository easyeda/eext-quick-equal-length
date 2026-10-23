import type { Line, Point } from './geometry';
import type { Box } from './routes';

const TAU = 2 * Math.PI, EPS = 1e-8;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mod = (a: number) => ((a % TAU) + TAU) % TAU;
const cache = new WeakMap<Line, { center: Point; radius: number; start: number; sweep: number }>();
export function arcGeometry(l: Line) {
	let g = cache.get(l);
	if (!g) {
		const sweep = (l.arcAngle ?? 0) * Math.PI / 180, dx = l.end.x - l.start.x, dy = l.end.y - l.start.y;
		if (!sweep || Math.abs(sweep) >= TAU - EPS || Math.hypot(dx, dy) < EPS) throw new Error('无效圆弧参数');
		const k = 1 / (2 * Math.tan(sweep / 2));
		const center = { x: (l.start.x + l.end.x) / 2 - dy * k, y: (l.start.y + l.end.y) / 2 + dx * k };
		g = { center, radius: distance(center, l.start), start: Math.atan2(l.start.y - center.y, l.start.x - center.x), sweep };
		cache.set(l, g);
	}
	return g;
}
export function copperLength(l: Line) { return l.arcAngle ? arcGeometry(l).radius * Math.abs(arcGeometry(l).sweep) : distance(l.start, l.end); }
const angleOn = (angle: number, g: ReturnType<typeof arcGeometry>) => mod(Math.sign(g.sweep) * (angle - g.start)) <= Math.abs(g.sweep) + EPS || mod(Math.sign(g.sweep) * (g.start - angle)) < EPS;
const onArc = (p: Point, g: ReturnType<typeof arcGeometry>) => angleOn(Math.atan2(p.y - g.center.y, p.x - g.center.x), g);
const polar = (g: ReturnType<typeof arcGeometry>, a: number): Point => ({ x: g.center.x + g.radius * Math.cos(a), y: g.center.y + g.radius * Math.sin(a) });
export function copperPoint(l: Line, t: number): Point {
	if (!l.arcAngle) return { x: l.start.x + (l.end.x - l.start.x) * t, y: l.start.y + (l.end.y - l.start.y) * t };
	const g = arcGeometry(l); return polar(g, g.start + g.sweep * t);
}
export function pointCopperDistance(p: Point, l: Line): number {
	if (!l.arcAngle) {
		const dx = l.end.x - l.start.x, dy = l.end.y - l.start.y, t = Math.max(0, Math.min(1, ((p.x - l.start.x) * dx + (p.y - l.start.y) * dy) / (dx * dx + dy * dy || 1)));
		return Math.hypot(p.x - l.start.x - t * dx, p.y - l.start.y - t * dy);
	}
	const g = arcGeometry(l), d = distance(p, g.center);
	return d < EPS || onArc(p, g) ? Math.abs(d - g.radius) : Math.min(distance(p, l.start), distance(p, l.end));
}
function lineLine(a: Line, b: Line) {
	const ax = a.end.x - a.start.x, ay = a.end.y - a.start.y, bx = b.end.x - b.start.x, by = b.end.y - b.start.y, den = ax * by - ay * bx;
	if (Math.abs(den) > EPS) {
		const dx = b.start.x - a.start.x, dy = b.start.y - a.start.y, t = (dx * by - dy * bx) / den, u = (dx * ay - dy * ax) / den;
		if (t >= 0 && t <= 1 && u >= 0 && u <= 1) return 0;
	}
	return Math.min(pointCopperDistance(a.start, b), pointCopperDistance(a.end, b), pointCopperDistance(b.start, a), pointCopperDistance(b.end, a));
}
export function copperDistance(a: Line, b: Line): number {
	if (!a.arcAngle && !b.arcAngle) return lineLine(a, b);
	let best = Math.min(pointCopperDistance(a.start, b), pointCopperDistance(a.end, b), pointCopperDistance(b.start, a), pointCopperDistance(b.end, a));
	if (a.arcAngle && b.arcAngle) {
		const x = arcGeometry(a), y = arcGeometry(b), dx = y.center.x - x.center.x, dy = y.center.y - x.center.y, d = Math.hypot(dx, dy);
		if (d < EPS) return best;
		const angle = Math.atan2(dy, dx);
		for (const s of [0, Math.PI]) for (const t of [0, Math.PI]) {
			const p = polar(x, angle + s), q = polar(y, angle + t);
			if (onArc(p, x) && onArc(q, y)) best = Math.min(best, distance(p, q));
		}
		if (d <= x.radius + y.radius + EPS && d >= Math.abs(x.radius - y.radius) - EPS) {
			const along = (d * d + x.radius * x.radius - y.radius * y.radius) / (2 * d), h = Math.sqrt(Math.max(0, x.radius * x.radius - along * along));
			for (const s of [-1, 1]) { const p = { x: x.center.x + along * dx / d - s * h * dy / d, y: x.center.y + along * dy / d + s * h * dx / d }; if (onArc(p, x) && onArc(p, y)) return 0; }
		}
		return best;
	}
	const arc = a.arcAngle ? a : b, line = a.arcAngle ? b : a, g = arcGeometry(arc);
	const dx = line.end.x - line.start.x, dy = line.end.y - line.start.y, len2 = dx * dx + dy * dy;
	if (len2 < EPS) return best;
	const projection = ((g.center.x - line.start.x) * dx + (g.center.y - line.start.y) * dy) / len2;
	if (projection >= 0 && projection <= 1) {
		const angle = Math.atan2(dx, -dy);
		for (const t of [angle, angle + Math.PI]) { const p = polar(g, t); if (onArc(p, g)) best = Math.min(best, pointCopperDistance(p, line)); }
	}
	const fx = line.start.x - g.center.x, fy = line.start.y - g.center.y, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - g.radius * g.radius, discriminant = B * B - 4 * len2 * C;
	if (discriminant >= -EPS) for (const s of [-1, 1]) {
		const t = (-B + s * Math.sqrt(Math.max(0, discriminant))) / (2 * len2);
		if (t >= -EPS && t <= 1 + EPS && onArc({ x: line.start.x + t * dx, y: line.start.y + t * dy }, g)) return 0;
	}
	return best;
}
const boxCache = new WeakMap<Line, Box>();
export function copperBounds(l: Line): Box {
	let box = boxCache.get(l);
	if (!box) {
		box = { minX: Math.min(l.start.x, l.end.x), maxX: Math.max(l.start.x, l.end.x), minY: Math.min(l.start.y, l.end.y), maxY: Math.max(l.start.y, l.end.y) };
		if (l.arcAngle) {
			const g = arcGeometry(l);
			for (let i = 0; i < 4; i++) {
				const a = i * Math.PI / 2;
				if (!angleOn(a, g)) continue;
				const p = polar(g, a);
				box.minX = Math.min(box.minX, p.x); box.maxX = Math.max(box.maxX, p.x);
				box.minY = Math.min(box.minY, p.y); box.maxY = Math.max(box.maxY, p.y);
			}
		}
		boxCache.set(l, box);
	}
	return box;
}
export function copperBoxDistance(l: Line, box: Box) {
	const inside = (p: Point) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
	if (inside(l.start) || inside(l.end)) return 0;
	const corners = [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }];
	return Math.min(...corners.map((start, i) => copperDistance(l, { ...l, arcAngle: undefined, start, end: corners[(i + 1) % 4] })));
}
/** Arc coverage on an axis, in true length units; accepts reversed and split arcs. */
export function arcInterval(l: Line, axis: Line): [number, number] | undefined {
	if (!l.arcAngle || !axis.arcAngle) return undefined;
	const a = arcGeometry(axis), g = arcGeometry(l);
	if (distance(a.center, g.center) > .001 || Math.abs(a.radius - g.radius) > .001) return undefined;
	const first = Math.sign(a.sweep) === Math.sign(g.sweep) ? g.start : g.start + g.sweep;
	const begin = mod(Math.sign(a.sweep) * (first - a.start)), size = Math.abs(g.sweep), end = Math.abs(a.sweep);
	const starts = [begin - TAU, begin, begin + TAU];
	starts.sort((x, y) => Math.min(end, y + size) - Math.max(0, y) - (Math.min(end, x + size) - Math.max(0, x)));
	return [starts[0] * a.radius, (starts[0] + size) * a.radius];
}
export function sameCopperGeometry(a: Line, b: Line, tolerance = .001): boolean {
	if (a.layer !== b.layer || a.net !== b.net || Math.abs(a.width - b.width) > tolerance || a.locked !== b.locked || !!a.arcAngle !== !!b.arcAngle) return false;
	const near = (p: Point, q: Point) => distance(p, q) <= tolerance;
	return (near(a.start, b.start) && near(a.end, b.end) && Math.abs((a.arcAngle ?? 0) - (b.arcAngle ?? 0)) <= tolerance) || (near(a.start, b.end) && near(a.end, b.start) && Math.abs((a.arcAngle ?? 0) + (b.arcAngle ?? 0)) <= tolerance);
}
export function copperInterval(l: Line, axis: Line): [number, number] | undefined {
	if (l.net !== axis.net || l.layer !== axis.layer || Math.abs(l.width - axis.width) > .001 || l.locked !== axis.locked || !!l.arcAngle !== !!axis.arcAngle) return undefined;
	if (l.arcAngle) return arcInterval(l, axis);
	const length = distance(axis.start, axis.end); if (length < .001) return undefined;
	const dx = (axis.end.x - axis.start.x) / length, dy = (axis.end.y - axis.start.y) / length;
	if ([l.start, l.end].some(p => Math.abs((p.x - axis.start.x) * dy - (p.y - axis.start.y) * dx) > .001)) return undefined;
	const values = [l.start, l.end].map(p => (p.x - axis.start.x) * dx + (p.y - axis.start.y) * dy);
	return [Math.min(...values), Math.max(...values)];
}

/** Build actual line/arc primitives; never emits an arc as sampled chords. */
export function copperPath(source: Line, initial = source.start) {
	const result: Line[] = []; let cursor = initial;
	const append = (end: Point, arcAngle?: number) => {
		if (distance(cursor, end) < 1e-8) return;
		const piece = { ...source, id: result.length ? `${source.id}/length/${result.length}` : source.id, start: cursor, end, arcAngle };
		const previous = result.at(-1);
		if (arcAngle && previous?.arcAngle && Math.sign(arcAngle) === Math.sign(previous.arcAngle) && Math.abs(arcAngle + previous.arcAngle) <= 180 + EPS && distance(arcGeometry(piece).center, arcGeometry(previous).center) < EPS) {
			result[result.length - 1] = { ...previous, end, arcAngle: previous.arcAngle + arcAngle };
		} else result.push(piece);
		cursor = end;
	};
	return { result, point: (p: Point) => append(p), arc: (start: Point, end: Point, angle: number) => { append(start); append(end, angle); } };
}
