import type { Point } from './geometry';
import type { Route } from './routes';

export interface ViaLink { id: string; net: string; point: Point; adjacentIds: string[] }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Join unique, host-confirmed via continuations. Pads and branch vias stop. */
export function crossLayerRoutes(routes: Route[], vias: ViaLink[]): Route[] {
	const links = new Map<string, { index: number; end: number }>();
	const key = (i: number, end: number) => `${i}/${end}`;
	for (const via of vias) {
		const adjacent = new Set(via.adjacentIds);
		if (adjacent.size !== 2) continue;
		const ports: { index: number; end: number; layer: number }[] = [];
		for (let i = 0; i < routes.length; i++) {
			const route = routes[i];
			if (route.net !== via.net || route.unsupported) continue;
			for (const end of [0, 1]) {
				const point = end ? route.points.at(-1)! : route.points[0], line = end ? route.lines.at(-1)! : route.lines[0];
				if (distance(point, via.point) <= .001 && adjacent.has(line.id)) ports.push({ index: i, end, layer: line.layer });
			}
		}
		if (ports.length !== 2 || ports[0].index === ports[1].index || ports[0].layer === ports[1].layer) continue;
		const [a, b] = ports;
		links.set(key(a.index, a.end), { index: b.index, end: b.end });
		links.set(key(b.index, b.end), { index: a.index, end: a.end });
	}
	const visited = new Set<number>(), result: Route[] = [];
	const walk = (first: number, firstEnd: number) => {
		let index = first, end = firstEnd, loop = false;
		const lines: Route['lines'] = [], points: Point[] = [], members: Route[] = [];
		let fixedStart = false, fixedEnd = false;
		while (!visited.has(index)) {
			visited.add(index); const route = routes[index]; members.push(route);
			const path = end ? [...route.points].reverse() : route.points;
			lines.push(...(end ? [...route.lines].reverse() : route.lines));
			points.push(...(points.length ? path.slice(1) : path));
			if (members.length === 1) fixedStart = end ? route.fixedEnd : route.fixedStart;
			fixedEnd = end ? route.fixedStart : route.fixedEnd;
			const next = links.get(key(index, 1 - end));
			if (!next) break;
			if (visited.has(next.index)) { loop = true; break; }
			index = next.index; end = next.end;
		}
		if (members.length === 1 && !loop) { result.push(members[0]); return; }
		result.push({ ...members[0], id: lines.map(l => l.id).sort().join('|'), layer: 0, lines, points, fixedStart, fixedEnd, locked: members.some(r => r.locked), unsupported: loop || members.some(r => r.unsupported) });
	};
	for (let i = 0; i < routes.length; i++) {
		if (visited.has(i)) continue;
		if (!links.has(key(i, 0))) walk(i, 0);
		else if (!links.has(key(i, 1))) walk(i, 1);
	}
	for (let i = 0; i < routes.length; i++) if (!visited.has(i)) walk(i, 0);
	return result;
}
