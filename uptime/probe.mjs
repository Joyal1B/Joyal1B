// Probes each production site once, appends the sample to a 30-day history
// and renders the README card. Node 22+, no dependencies.
// Usage: node uptime/probe.mjs <previous-history.json> <out-dir> [--render-only]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const [prevPath, outDir = 'out'] = process.argv.slice(2);
const renderOnly = process.argv.includes('--render-only');
const sites = JSON.parse(await readFile(join(here, 'sites.json'), 'utf8'));
const WINDOW_MS = 30 * 24 * 3600e3;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 uptime-probe (+https://github.com/Joyal1B)';

let history = { samples: [] };
try { history = JSON.parse(await readFile(prevPath, 'utf8')); } catch {}

// One retry after 5 s, so a transient DNS or TLS hiccup never shows as an outage.
async function probe(site) {
  const first = await probeOnce(site);
  if (first.ok) return first;
  await new Promise((r) => setTimeout(r, 5000));
  return probeOnce(site);
}

async function probeOnce(site) {
  const t0 = performance.now();
  try {
    const res = await fetch(site.url, { redirect: 'follow', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) });
    await res.arrayBuffer();
    return { id: site.id, ok: res.status < 400, code: res.status, ms: Math.round(performance.now() - t0) };
  } catch (err) {
    return { id: site.id, ok: false, code: 0, ms: null, err: String(err.name || err) };
  }
}

if (!renderOnly) {
  const results = await Promise.all(sites.map(probe));
  history.samples.push({ t: new Date().toISOString(), results });
}
const now = Date.now();
history.samples = history.samples.filter((s) => now - Date.parse(s.t) <= WINDOW_MS);

// ---------- stats ----------
const stats = sites.map((site) => {
  const rows = history.samples.map((s) => s.results.find((r) => r.id === site.id)).filter(Boolean);
  const up = rows.filter((r) => r.ok).length;
  const last = rows.at(-1);
  const lat = rows.filter((r) => r.ok && r.ms != null).slice(-24).map((r) => r.ms).sort((a, b) => a - b);
  return {
    ...site,
    last,
    uptime: rows.length ? (up / rows.length) * 100 : null,
    p50: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    spark: rows.slice(-48),
  };
});
const online = stats.filter((s) => s.last?.ok).length;
const first = history.samples[0] ? new Date(history.samples[0].t) : new Date();
const fullWindow = now - first.getTime() >= WINDOW_MS - 3600e3;
const windowLabel = fullWindow ? 'sur 30 jours' : `depuis le ${first.toISOString().slice(8, 10)}/${first.toISOString().slice(5, 7)}`;
const lastT = history.samples.at(-1)?.t ?? new Date().toISOString();
const stamp = `${lastT.slice(8, 10)}/${lastT.slice(5, 7)}/${lastT.slice(0, 4)} ${lastT.slice(11, 16)} UTC`;
const globalUptime = stats.filter((s) => s.uptime != null);
const avgUptime = globalUptime.length ? globalUptime.reduce((a, s) => a + s.uptime, 0) / globalUptime.length : null;

// ---------- render ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pct = (v) => (v == null ? '—' : v >= 99.995 ? '100 %' : `${v.toFixed(2).replace('.', ',')} %`);
const W = 1280, HEAD = 150, ROW = 64, FOOT = 56;
const H = HEAD + ROW * stats.length + FOOT;
const C = { bg: '#0a0e16', panel: '#0f1623', line: '#1a2333', text: '#f4f7fc', mute: '#5b6b82', soft: '#8fa3bf', cyan: '#36e0ff', violet: '#8b5cf6', ok: '#34d399', ko: '#f87171' };
const mono = "'JetBrains Mono','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";
const sans = "'Inter','Segoe UI','Helvetica Neue',Arial,sans-serif";
const allUp = online === stats.length;

const rowsSvg = stats.map((s, i) => {
  const y = HEAD + i * ROW;
  const ok = s.last?.ok;
  const dot = ok ? C.ok : C.ko;
  const bars = Array.from({ length: 48 }, (_, k) => {
    const r = s.spark[s.spark.length - 48 + k];
    const fill = !r ? C.line : r.ok ? C.ok : C.ko;
    const op = !r ? 1 : r.ok ? 0.85 : 1;
    return `<rect x="${560 + k * 8}" y="${y + 20}" width="5" height="24" rx="1.5" fill="${fill}" opacity="${op}"/>`;
  }).join('');
  return `
  <g class="row" style="animation-delay:${0.15 + i * 0.08}s">
    <rect x="40" y="${y + 6}" width="${W - 80}" height="${ROW - 12}" rx="12" fill="${C.panel}"/>
    <circle cx="72" cy="${y + 32}" r="11" fill="${dot}" opacity=".18" class="${ok ? 'halo' : ''}"/>
    <circle cx="72" cy="${y + 32}" r="5.5" fill="${dot}"/>
    <text x="98" y="${y + 29}" font-family="${sans}" font-size="19" font-weight="700" fill="${C.text}">${esc(s.name)}</text>
    <text x="98" y="${y + 48}" font-family="${mono}" font-size="12.5" fill="${C.mute}">${esc(new URL(s.url).host)}  ·  ${esc(s.kind)}</text>
    ${bars}
    <text x="1060" y="${y + 38}" text-anchor="end" font-family="${mono}" font-size="16" fill="${C.soft}">${s.p50 == null ? '—' : s.p50 + ' ms'}</text>
    <text x="1210" y="${y + 38}" text-anchor="end" font-family="${mono}" font-size="17" font-weight="700" fill="${s.uptime == null ? C.mute : s.uptime >= 99 ? C.ok : C.ko}">${pct(s.uptime)}</text>
  </g>`;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Systèmes en production : ${online} sur ${stats.length} en ligne">
<style>
  .row{opacity:0;animation:in .6s ease-out forwards}
  .halo{transform-box:fill-box;transform-origin:center;animation:pulse 2.4s ease-in-out infinite}
  .live{animation:blink 1.6s steps(2,start) infinite}
  @keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @keyframes pulse{0%,100%{transform:scale(.7);opacity:.35}50%{transform:scale(1.5);opacity:0}}
  @keyframes blink{to{visibility:hidden}}
  @media (prefers-reduced-motion:reduce){.row{animation:none;opacity:1}.halo,.live{animation:none}}
</style>
<defs>
  <linearGradient id="edge" x1="0" x2="1"><stop offset="0" stop-color="${C.cyan}"/><stop offset=".55" stop-color="${C.violet}"/><stop offset="1" stop-color="${C.cyan}" stop-opacity="0"/></linearGradient>
  <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse"><path d="M32 0H0V32" fill="none" stroke="${C.line}" stroke-width="1" opacity=".55"/></pattern>
</defs>
<rect width="${W}" height="${H}" rx="22" fill="${C.bg}"/>
<rect width="${W}" height="${H}" rx="22" fill="url(#grid)" opacity=".5"/>
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="21" fill="none" stroke="${C.line}" stroke-width="2"/>
<rect x="40" y="0" width="420" height="3" fill="url(#edge)"/>

<circle cx="52" cy="58" r="6" fill="${allUp ? C.ok : C.ko}" class="live"/>
<text x="68" y="64" font-family="${mono}" font-size="15" letter-spacing="3" fill="${C.cyan}">SYSTÈMES EN PRODUCTION · LIVE</text>
<text x="40" y="104" font-family="${sans}" font-size="30" font-weight="800" fill="${C.text}">Sondés toutes les heures, depuis GitHub Actions.</text>
<text x="1240" y="70" text-anchor="end" font-family="${sans}" font-size="44" font-weight="800" fill="${allUp ? C.ok : C.ko}">${online}/${stats.length}</text>
<text x="1240" y="98" text-anchor="end" font-family="${mono}" font-size="13" letter-spacing="2" fill="${C.soft}">EN LIGNE · DISPO ${pct(avgUptime)}</text>
<text x="560" y="${HEAD - 8}" font-family="${mono}" font-size="11.5" letter-spacing="1.5" fill="${C.mute}">48 DERNIERS RELEVÉS</text>
<text x="1060" y="${HEAD - 8}" text-anchor="end" font-family="${mono}" font-size="11.5" letter-spacing="1.5" fill="${C.mute}">MÉDIANE 24 H</text>
<text x="1210" y="${HEAD - 8}" text-anchor="end" font-family="${mono}" font-size="11.5" letter-spacing="1.5" fill="${C.mute}">DISPO</text>
${rowsSvg}
<text x="40" y="${H - 22}" font-family="${mono}" font-size="12.5" fill="${C.mute}">dernier relevé ${stamp}  ·  ${history.samples.length} relevés ${windowLabel}  ·  aucune donnée privée, rien que des requêtes publiques</text>
<text x="1240" y="${H - 22}" text-anchor="end" font-family="${mono}" font-size="12.5" fill="${C.cyan}">ONE HUMAN · A PACK OF AGENTS</text>
</svg>
`;

await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'uptime.json'), JSON.stringify(history));
await writeFile(join(outDir, 'uptime.svg'), svg);
console.log(`${online}/${stats.length} online · ${history.samples.length} samples`);
for (const s of stats) console.log(`  ${s.last?.ok ? 'UP  ' : 'DOWN'} ${s.last?.code} ${s.last?.ms ?? '-'}ms ${s.name}`);
