// 행정동 인구 → public/data/dongs.json
// 실행: node scripts/dongs.js <주민등록 연령별인구현황 CSV 경로>
//   CSV: jumin.mois.go.kr → 연령별 인구현황 → 전국 / 계·남·여 / 10세 / 전체읍면동현황 → csv 다운로드
//   행정동 경계는 github.com/vuski/admdongkor 에서 받아 중심점만 계산해 쓴다.
const fs = require('fs');
const path = require('path');

const GEO = 'https://raw.githubusercontent.com/vuski/admdongkor/master/ver20260701/HangJeongDong_ver20260701.geojson';
const OUT = path.join(__dirname, '..', 'public', 'data', 'dongs.json');

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = '', q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

// 폴리곤 면적 가중 중심점 (가장 큰 조각 기준)
function centroid(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
  let best = null;
  for (const poly of polys) {
    const ring = poly[0];
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
      a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
    }
    if (!best || Math.abs(a) > Math.abs(best.a)) best = { a, x: cx / (3 * a), y: cy / (3 * a) };
  }
  return [+best.y.toFixed(5), +best.x.toFixed(5)];
}

(async () => {
  const file = process.argv[2];
  if (!file) { console.log('사용법: node scripts/dongs.js <CSV 파일 경로>'); process.exit(1); }
  const buf = fs.readFileSync(file);
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!text.includes('행정구역')) text = new TextDecoder('euc-kr').decode(buf);
  const rows = parseCsv(text);
  const head = rows[0];
  const ym = (head[1].match(/(\d{4})년(\d{2})월/) || []).slice(1).join('');
  const col = (sex, band) => head.findIndex((h) => h.includes(`_${sex}_${band}`));
  const BANDS = ['0~9세', '10~19세', '20~29세', '30~39세', '40~49세', '50~59세', '60~69세', '70~79세', '80~89세', '90~99세', '100세 이상'];
  const idx = { 남: BANDS.map((b) => col('남', b)), 여: BANDS.map((b) => col('여', b)) };
  if ([...idx.남, ...idx.여].some((i) => i < 0)) throw new Error('CSV 열을 찾지 못했어요. 계·남·여, 10세 단위로 받았는지 확인해 주세요.');
  const num = (s) => +String(s || '0').replace(/,/g, '') || 0;

  console.log('행정동 경계 받는 중…');
  const geo = await (await fetch(GEO)).json();
  const pos = new Map(geo.features.map((f) => [f.properties.adm_cd2, centroid(f.geometry)]));

  const sidos = [], dongs = new Map();
  let skipped = 0;
  for (const r of rows.slice(1)) {
    const m = r[0].match(/^(\S+).*\((\d{10})\)\s*$/);
    if (!m) continue;
    let code = m[2];
    if (code.endsWith('00000')) continue; // 시도·시군구 합계 줄
    // 10대 구간 10개(90세 이상은 하나로)
    const pick = (sex) => { const v = idx[sex].map((i) => num(r[i])); v[9] += v[10]; return v.slice(0, 10); };
    const men = pick('남'), women = pick('여');
    if (!men.some(Boolean) && !women.some(Boolean)) continue;
    if (!pos.has(code)) code = code.slice(0, 7) + '000'; // 출장소 → 소속 읍면동
    if (!pos.has(code)) { skipped++; continue; }
    let s = sidos.indexOf(m[1]);
    if (s < 0) s = sidos.push(m[1]) - 1;
    const d = dongs.get(code);
    if (d) { for (let i = 0; i < 10; i++) { d[3 + i] += men[i]; d[13 + i] += women[i]; } }
    else dongs.set(code, [...pos.get(code), s, ...men, ...women]);
  }
  const out = { month: ym, sidos, bands: ['0~9', '10~19', '20~29', '30~39', '40~49', '50~59', '60~69', '70~79', '80~89', '90+'], rows: [...dongs.values()] };
  fs.writeFileSync(OUT, JSON.stringify(out));
  const total = out.rows.reduce((t, d) => t + d.slice(3).reduce((a, b) => a + b, 0), 0);
  console.log(`완료: 행정동 ${out.rows.length}곳, 인구 ${total.toLocaleString()}명 (${ym} 기준), 못 찾은 동 ${skipped}곳`);
  console.log(`파일 크기 ${(fs.statSync(OUT).size / 1024).toFixed(0)}KB → ${OUT}`);
})().catch((e) => { console.error('실패:', e.message); process.exit(1); });
