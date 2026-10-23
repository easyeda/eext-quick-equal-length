import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_PATH||'C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const b=await build({stdin:{contents:`export * from './src/length-planner';export {buildRoutes} from './src/routes';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm'});
const m=await import(`data:text/javascript;base64,${Buffer.from(b.outputFiles[0].text).toString('base64')}`);
const line={id:'A',net:'A',layer:1,width:8,locked:false,start:{x:0,y:0},end:{x:300,y:0}};
const chosen=m.selectTargets(m.buildRoutes([line],[]),[line],1,'segment',['A']);
const styles=[['single','单边蛇形','连续圆角 · 向一侧展开'],['double','双边蛇形','连续圆角 · 两侧交替'],['large','大折返','少量宽幅绕线 · 保留原方式']];
const data=[];const articles=[];
for(const [pattern,title,description] of styles){
 const p=m.planLengths([line],chosen,{target:400,amplitude:100,minAmplitude:10,pitch:20,clearance:6,tolerance:.01,side:'left',pattern,lobes:4});
 data.push({pattern,rows:p.rows,geometry:p.groups[0]});
 const points=[p.groups[0][0].start,...p.groups[0].map(l=>l.end)].map(q=>`${(95+q.y*1.15).toFixed(4)},${(24+q.x*1.15).toFixed(4)}`).join(' ');
 articles.push(`<article><h2>${title}</h2><p>${description}</p><svg viewBox="0 0 230 395"><defs><pattern id="grid-${pattern}" width="10" height="10" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".6" fill="#263344"/></pattern></defs><rect width="230" height="395" fill="url(#grid-${pattern})"/><line x1="95" y1="24" x2="95" y2="369" stroke="#7c8da6" stroke-width="1" stroke-dasharray="3 4"/><polyline points="${points}" fill="none" stroke="#ff3838" stroke-width="9.2" stroke-linejoin="round" stroke-linecap="round"/></svg><footer>${p.rows[0].after.toFixed(3)} mil</footer></article>`);
}
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>等长方式</title><style>*{box-sizing:border-box}body{margin:0;padding:26px;background:#0c1420;color:#e5edf7;font-family:'Microsoft YaHei',sans-serif}h1{font-size:23px;margin:0 0 5px}header p{font-size:12px;color:#8f9eb1;margin:0 0 19px}main{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}article{padding:15px 12px 10px;border:1px solid #293749;border-radius:9px;background:#111d2b}h2{font-size:17px;margin:0 0 5px}article p{font-size:10px;color:#97a6b8;margin:0 0 10px;height:16px}svg{width:100%;display:block}footer{text-align:center;font-size:12px;color:#a7b9ce;margin-top:7px;font-variant-numeric:tabular-nums}</style><header><h1>三种等长方式</h1><p>同一段300mil直线补至400mil · W=20mil · H≥10mil · 单边/双边4波 · 按实际生成几何绘制</p></header><main>${articles.join('')}</main></html>`;
await fs.mkdir('validation',{recursive:true});await fs.writeFile('validation/meander-styles.html',html);await fs.writeFile('validation/meander-styles.json',JSON.stringify(data,null,2));
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe'});
try{const page=await browser.newPage({viewport:{width:840,height:600},deviceScaleFactor:2});await page.goto(pathToFileURL(`${process.cwd()}/validation/meander-styles.html`).href);await page.screenshot({path:'validation/meander-styles.png',fullPage:true});}finally{await browser.close();}
console.info('Actual generated geometry preview: validation/meander-styles.png');
