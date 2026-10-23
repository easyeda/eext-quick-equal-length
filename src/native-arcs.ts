import type { Line } from './geometry';
import type { Box } from './routes';
import { copperBounds } from './copper';

// EasyEDA 4.1.71 getAll/get round ARC endpoints to .1mil, although create and
// native bounding boxes retain their real precision. Recover only a known
// journal geometry whose independently queried native bounds also agree.
const KEYS = ['track-length-journal-v1', 'track-length-journal-progress-v1'];
export async function resolveArcPrecision(doc: IDMT_EditorDocumentItem, raw: Line[], known: Line[] = [], boxes?: Map<string, Box>): Promise<Line[]> {
	for (const key of KEYS) {
		const journal = eda.sys_Storage.getExtensionUserConfig(key);
		if (journal?.doc?.uuid === doc.uuid && journal?.doc?.parentProjectUuid === doc.parentProjectUuid) known = known.concat(journal.before ?? [], journal.target ?? []);
	}
	const candidates = known.filter(l => l.arcAngle);
	if (!candidates.length) return raw;
	return await Promise.all(raw.map(async l => {
		const close = (a: number, b: number) => Math.abs(a - b) <= .051;
		const matches = candidates.flatMap(c => {
			if (c.net !== l.net || c.layer !== l.layer || Math.abs(c.width - l.width) > .001 || c.locked !== l.locked) return [];
			if (close(c.arcAngle!, l.arcAngle!) && close(c.start.x, l.start.x) && close(c.start.y, l.start.y) && close(c.end.x, l.end.x) && close(c.end.y, l.end.y)) return [c];
			if (close(-c.arcAngle!, l.arcAngle!) && close(c.end.x, l.start.x) && close(c.end.y, l.start.y) && close(c.start.x, l.end.x) && close(c.start.y, l.end.y)) return [{ ...c, start: c.end, end: c.start, arcAngle: -c.arcAngle! }];
			return [];
		});
		if (!matches.length) return l;
		const box = boxes?.get(l.id) ?? await eda.pcb_Primitive.getPrimitivesBBox([l.id]);
		if (!box) throw new Error(`无法核对圆弧 ${l.id} 的原始精度`);
		const found = matches.find(c => { const b = copperBounds(c), pad = c.width / 2; return Math.abs(b.minX - pad - box.minX) <= .001 && Math.abs(b.maxX + pad - box.maxX) <= .001 && Math.abs(b.minY - pad - box.minY) <= .001 && Math.abs(b.maxY + pad - box.maxY) <= .001; });
		return found ? { ...found, id: l.id, interactiveMode: l.interactiveMode } : l;
	}));
}
