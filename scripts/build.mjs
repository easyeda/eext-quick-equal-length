import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import JSZip from 'jszip';
const manifest = JSON.parse(await fs.readFile('extension.json', 'utf8'));
await fs.mkdir('dist', { recursive: true });
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/index.js', bundle: true, format: 'iife', globalName: 'edaEsbuildExportName', platform: 'browser', target: 'es2020', charset: 'utf8' });
const panel = await build({ entryPoints: ['src/panel.ts'], bundle: true, write: false, format: 'iife', target: 'es2020', charset: 'utf8' });
let html = await fs.readFile('iframe/panel.template.html', 'utf8');
const css = await fs.readFile('iframe/style.css', 'utf8');
const watchdog = `window.addEventListener('error',function(e){document.getElementById('status').textContent='面板启动失败：'+e.message;});window.addEventListener('unhandledrejection',function(e){document.getElementById('status').textContent='面板操作失败：'+String(e.reason);});`;
html = html.replace('<link rel="stylesheet" href="/iframe/style.css">', () => `<style>${css}</style>`).replace('<script src="/iframe/app.js"></script>', () => `<script>${watchdog}\n${panel.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script>`);
await fs.writeFile('iframe/index.html', html);
if (!process.argv.includes('--compile-only')) {
	const zip = new JSZip();
	for (const dir of ['dist', 'locales', 'images']) for (const name of await fs.readdir(dir, { recursive: true })) {
		const file = path.join(dir, name); if ((await fs.stat(file)).isFile()) zip.file(file.replaceAll('\\', '/'), await fs.readFile(file));
	}
	for (const file of ['extension.json', 'iframe/index.html', 'README.md', 'CHANGELOG.md', 'LICENSE']) zip.file(file, await fs.readFile(file));
	await fs.mkdir('build/dist', { recursive: true });
	const file = `build/dist/${manifest.name}_v${manifest.version}.eext`;
	await fs.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
	console.info(`Packaged ${file}`);
}
