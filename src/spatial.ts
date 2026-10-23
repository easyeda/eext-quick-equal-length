import type { Box } from './routes';
const overlaps = (a: Box, b: Box) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
/** Exact broad phase: boxes only reject distant objects; narrow phase keeps all rules. */
export class SpatialIndex<T> {
	private cells = new Map<string, { item: T; box: Box }[]>();
	private overflow: { item: T; box: Box }[] = [];
	private all: { item: T; box: Box }[];
	constructor(items: T[], box: (item: T) => Box, private cell = 64) {
		this.all = items.map(item => ({ item, box: box(item) }));
		for (const entry of this.all) {
			const b = this.grid(entry.box);
			if ((b.maxX - b.minX + 1) * (b.maxY - b.minY + 1) > 256) { this.overflow.push(entry); continue; }
			for (let x = b.minX; x <= b.maxX; x++) for (let y = b.minY; y <= b.maxY; y++) {
				const k = `${x}/${y}`, list = this.cells.get(k); if (list) list.push(entry); else this.cells.set(k, [entry]);
			}
		}
	}
	private grid(b: Box): Box { return { minX: Math.floor(b.minX / this.cell), maxX: Math.floor(b.maxX / this.cell), minY: Math.floor(b.minY / this.cell), maxY: Math.floor(b.maxY / this.cell) }; }
	query(box: Box, padding = 0): T[] {
		const area = { minX: box.minX - padding, maxX: box.maxX + padding, minY: box.minY - padding, maxY: box.maxY + padding }, b = this.grid(area);
		if ((b.maxX - b.minX + 1) * (b.maxY - b.minY + 1) > 1024) return this.all.filter(e => overlaps(e.box, area)).map(e => e.item);
		const found = new Set(this.overflow);
		for (let x = b.minX; x <= b.maxX; x++) for (let y = b.minY; y <= b.maxY; y++) for (const e of this.cells.get(`${x}/${y}`) ?? []) found.add(e);
		return [...found].filter(e => overlaps(e.box, area)).map(e => e.item);
	}
}
