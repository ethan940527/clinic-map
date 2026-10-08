// 행정안전부 의원 인허가 데이터 → public/data/clinics.json
// 실행: DATA_KEY=인증키(Decoding) node scripts/build.js   (키가 없으면 실행할 때 물어봄)
const fs = require('fs');
const path = require('path');
const proj4 = require('proj4');

proj4.defs('EPSG:5174', '+proj=tmerc +lat_0=38 +lon_0=127.0028902777778 +k=1 +x_0=200000 +y_0=500000 +ellps=bessel +units=m +no_defs +towgs84=-115.80,474.99,674.11,1.16,-2.31,-1.63,6.43');

const BASE = 'https://apis.data.go.kr/1741000/clinics/info';
const ROWS = 100;
const KEEP_CLOSED_YEARS = 3; // 폐업은 최근 3년치만 보관
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 간판에 쓰는 진료과 (이름에 들어 있으면 그 과로 본다). 순서 = 우선순위
const DEPTS = ['성형외과', '피부과', '안과', '이비인후과', '소아청소년과', '소아과', '산부인과', '여성의원', '비뇨의학과', '비뇨기과',
  '정형외과', '신경외과', '마취통증의학과', '통증의학과', '재활의학과', '신경과', '정신건강의학과', '정신과', '가정의학과', '내과', '외과',
  '영상의학과', '진단검사의학과', '흉부외과', '직업환경의학과', '응급의학과', '방사선종양학과', '병리과', '핵의학과'];
const ALIAS = { 소아과: '소아청소년과', 여성의원: '산부인과', 비뇨기과: '비뇨의학과', 통증의학과: '마취통증의학과', 정신과: '정신건강의학과' };

function deptOf(name, subjects) {
  const n = (name || '').replace(/\s+/g, '');
  for (const d of DEPTS) if (n.includes(d)) return ALIAS[d] || d;
  const first = (subjects || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (first.length === 1) return ALIAS[first[0]] || first[0];
  return '일반의원'; // 간판에 과가 없고 여러 과를 함께 보는 곳
}

const ymd = (s) => (s ? +String(s).replace(/-/g, '').slice(0, 8) || 0 : 0);

async function page(key, pageNo, tries = 4) {
  const qs = new URLSearchParams({ serviceKey: key, pageNo, numOfRows: ROWS, returnType: 'json' });
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${BASE}?${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      const body = j?.response?.body;
      if (!body) throw new Error(JSON.stringify(j).slice(0, 200));
      let items = body.items?.item || [];
      if (!Array.isArray(items)) items = [items];
      return { items, total: +body.totalCount || 0 };
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(1000 * (i + 1));
    }
  }
}

async function getKey() {
  if (process.env.DATA_KEY) return process.env.DATA_KEY.trim();
  const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question('공공데이터포털 인증키(Decoding): ', (a) => { rl.close(); r(a.trim()); }));
}

(async () => {
  const key = await getKey();
  const first = await page(key, 1);
  const pages = Math.ceil(first.total / ROWS);
  console.log(`전체 ${first.total.toLocaleString()}건, ${pages}페이지 수집 시작`);

  const now = new Date(Date.now() + 9 * 3600e3);
  const cutoff = (now.getUTCFullYear() - KEEP_CLOSED_YEARS) * 10000 + (now.getUTCMonth() + 1) * 100 + now.getUTCDate();

  const deptIdx = new Map();
  const rows = [];
  let latest = 0, skipped = 0;

  const handle = (it) => {
    if (!/의원/.test(it.BZSTAT_SE_NM || it.MDLCR_INST_BTP_NM || '의원')) return;
    if (/치과|한의/.test(`${it.BZSTAT_SE_NM}${it.BPLC_NM}`)) return; // 의과 의원만
    const open = ymd(it.LCPMT_YMD);
    const close = ymd(it.CLSBIZ_YMD);
    const active = it.SALS_STTS_CD === '01';
    if (!active && !(close && close >= cutoff)) return; // 오래전 폐업·휴업 등은 제외
    const x = +it.CRD_INFO_X, y = +it.CRD_INFO_Y;
    if (!x || !y) { skipped++; return; }
    const [lng, lat] = proj4('EPSG:5174', 'WGS84', [x, y]);
    if (!(lat > 33 && lat < 39 && lng > 124 && lng < 132)) { skipped++; return; }
    const d = deptOf(it.BPLC_NM, it.MDEXM_SBJCT_CN_NM);
    if (!deptIdx.has(d)) deptIdx.set(d, deptIdx.size);
    rows.push([+lat.toFixed(5), +lng.toFixed(5), deptIdx.get(d), open, active ? 0 : close || 1, it.BPLC_NM || '']);
    const upd = ymd(it.DAT_UPDT_PNT); if (upd > latest) latest = upd;
  };

  first.items.forEach(handle);
  for (let p = 2; p <= pages; p++) {
    const { items } = await page(key, p);
    items.forEach(handle);
    if (p % 50 === 0) console.log(`  ${p}/${pages}`);
    await sleep(60);
  }

  const out = {
    updatedAt: new Date().toISOString(),
    dataDate: latest, // 원천 데이터 갱신일 (보통 이틀 전)
    closedSince: cutoff,
    depts: [...deptIdx.keys()],
    // [위도, 경도, 진료과번호, 인허가일, 폐업일(0=영업중), 이름]
    rows,
  };
  const file = path.join(__dirname, '..', 'public', 'data', 'clinics.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  const active = rows.filter((r) => !r[4]).length;
  console.log(`완료: 영업중 ${active.toLocaleString()}곳, 최근 ${KEEP_CLOSED_YEARS}년 폐업 ${(rows.length - active).toLocaleString()}곳, 좌표없음 ${skipped}곳`);
  console.log(`파일 크기 ${(fs.statSync(file).size / 1e6).toFixed(1)}MB → ${file}`);
})().catch((e) => { console.error('실패:', e.message); process.exit(1); });
