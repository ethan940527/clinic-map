(() => {
  const KAKAO_KEY = '6afa60c134993264035a6862fb568f78'; // 등록한 도메인에서만 작동
  const qs = new URLSearchParams(location.search);
  if (qs.get('theme')) document.documentElement.dataset.theme = qs.get('theme');

  const $ = (id) => document.getElementById(id);
  const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_DOTS = 900;   // 이보다 많으면 점은 안 그리고 숫자만
  const DOT_LEVEL = 5;    // 이 레벨 이하(더 확대)일 때 점 표시

  let data, pop, map, overlays = [], yr = 1, dept = null, since = 0, showClosed = false;
  let home;          // 의원별 소속 행정동 번호 (가장 가까운 행정동 중심점)
  const sidoCache = new Map();

  const fmtD = (n) => (n ? `${String(n).slice(0, 4)}.${String(n).slice(4, 6)}.${String(n).slice(6, 8)}` : '');
  const sinceOf = (years) => {
    const d = new Date(Date.now() + 9 * 3600e3);
    return (d.getUTCFullYear() - years) * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  };

  function loadKakao() {
    return new Promise((ok, fail) => {
      const s = document.createElement('script');
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_KEY}&libraries=services&autoload=false`;
      s.onload = () => kakao.maps.load(ok);
      s.onerror = () => fail(new Error('지도를 불러오지 못했어요.'));
      document.head.appendChild(s);
    });
  }

  function inBounds() {
    const b = map.getBounds();
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const la1 = sw.getLat(), la2 = ne.getLat(), lo1 = sw.getLng(), lo2 = ne.getLng();
    return data.rows.filter((r) => r[0] >= la1 && r[0] <= la2 && r[1] >= lo1 && r[1] <= lo2);
  }

  // r: [위도, 경도, 진료과, 인허가일, 폐업일(0=영업중), 이름]
  const isActive = (r) => !r[4];
  const isNew = (r) => r[3] >= since && !r[4];
  const isClosed = (r) => r[4] && r[4] >= since;

  // ── 인구 ────────────────────────────────────────────────
  // pop.rows: [위도, 경도, 시도, 남 0~9 … 90+ (10칸), 여 0~9 … 90+ (10칸)]
  const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const range = (a, b) => ALL.slice(a, b + 1);
  const TARGETS = {
    소아청소년과: { label: '0~19세', m: range(0, 1), f: range(0, 1) },
    피부과: { label: '20~49세', m: range(2, 4), f: range(2, 4), female: true },
    성형외과: { label: '20~49세', m: range(2, 4), f: range(2, 4), female: true },
    산부인과: { label: '20~59세 여성', m: [], f: range(2, 5) },
    비뇨의학과: { label: '40세 이상 남성', m: range(4, 9), f: [] },
    정형외과: { label: '50세 이상', m: range(5, 9), f: range(5, 9) },
    재활의학과: { label: '50세 이상', m: range(5, 9), f: range(5, 9) },
    마취통증의학과: { label: '50세 이상', m: range(5, 9), f: range(5, 9) },
    신경외과: { label: '50세 이상', m: range(5, 9), f: range(5, 9) },
    신경과: { label: '60세 이상', m: range(6, 9), f: range(6, 9) },
    정신건강의학과: { label: '20~59세', m: range(2, 5), f: range(2, 5) },
  };
  const EVERYONE = { label: '전체', m: ALL, f: ALL };
  const targetOf = (k) => (k == null ? EVERYONE : TARGETS[data.depts[k]] || EVERYONE);
  const tpop = (d, t) => t.m.reduce((s, i) => s + d[3 + i], 0) + t.f.reduce((s, i) => s + d[13 + i], 0);

  function assignHomes() {
    const G = 0.05, grid = new Map();
    const key = (la, lo) => `${Math.floor(la / G)}:${Math.floor(lo / G)}`;
    pop.rows.forEach((d, i) => { const k = key(d[0], d[1]); (grid.get(k) || grid.set(k, []).get(k)).push(i); });
    home = new Int32Array(data.rows.length);
    data.rows.forEach((r, n) => {
      const gy = Math.floor(r[0] / G), gx = Math.floor(r[1] / G);
      let best = -1, bd = Infinity;
      for (let reach = 1; reach <= 4 && best < 0; reach++) {
        for (let y = gy - reach; y <= gy + reach; y++) for (let x = gx - reach; x <= gx + reach; x++) {
          for (const i of grid.get(`${y}:${x}`) || []) {
            const d = pop.rows[i], dy = d[0] - r[0], dx = (d[1] - r[1]) * 0.8;
            const dist = dy * dy + dx * dx;
            if (dist < bd) { bd = dist; best = i; }
          }
        }
      }
      home[n] = best;
    });
  }

  // 시도 평균: 대상 인구 ÷ 영업 중 의원 수 (진료과별)
  function sidoAvg(s, k) {
    const ck = `${s}:${k}`;
    if (sidoCache.has(ck)) return sidoCache.get(ck);
    const t = targetOf(k);
    let people = 0, fem = 0, band = 0, clinics = 0;
    for (const d of pop.rows) if (d[2] === s) {
      people += tpop(d, t);
      if (t.female) { fem += t.f.reduce((a, i) => a + d[13 + i], 0); band += tpop(d, t); }
    }
    data.rows.forEach((r, n) => { if (isActive(r) && (k == null || r[2] === k) && home[n] >= 0 && pop.rows[home[n]][2] === s) clinics++; });
    const v = { per: clinics ? people / clinics : null, femShare: band ? fem / band : null };
    sidoCache.set(ck, v);
    return v;
  }

  function popStats() {
    const b = map.getBounds();
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const inView = new Set();
    pop.rows.forEach((d, i) => { if (d[0] >= sw.getLat() && d[0] <= ne.getLat() && d[1] >= sw.getLng() && d[1] <= ne.getLng()) inView.add(i); });
    const bySido = new Map();
    for (const i of inView) { const d = pop.rows[i]; bySido.set(d[2], (bySido.get(d[2]) || 0) + tpop(d, EVERYONE)); }
    const sido = [...bySido.entries()].sort((a, b2) => b2[1] - a[1])[0]?.[0];
    const clinicsBy = new Map();
    data.rows.forEach((r, n) => { if (isActive(r) && inView.has(home[n])) clinicsBy.set(r[2], (clinicsBy.get(r[2]) || 0) + 1); });
    const people = (k) => { const t = targetOf(k); let s = 0; for (const i of inView) s += tpop(pop.rows[i], t); return s; };
    const clinics = (k) => (k == null ? [...clinicsBy.values()].reduce((a, b2) => a + b2, 0) : clinicsBy.get(k) || 0);
    const femShare = (k) => {
      const t = targetOf(k); if (!t.female) return null;
      let f = 0, all = 0;
      for (const i of inView) { const d = pop.rows[i]; f += t.f.reduce((a, j) => a + d[13 + j], 0); all += tpop(d, t); }
      return all ? f / all : null;
    };
    return { dongs: inView.size, sido, people, clinics, femShare };
  }

  const fmtN = (n) => Math.round(n).toLocaleString();
  const pct = (x) => `${Math.round(x * 100)}%`;

  function popCard(P) {
    if (!pop) return '';
    if (!P.dongs) return `<div class="popcard"><p class="pmeta">지도를 조금 넓히면 이 지역 인구 기준 경쟁 강도가 계산돼요.</p></div>`;
    const t = targetOf(dept);
    const ppl = P.people(dept), cl = P.clinics(dept);
    const avg = P.sido != null ? sidoAvg(P.sido, dept) : null;
    const sidoNm = P.sido != null ? pop.sidos[P.sido].replace(/(특별자치시|특별자치도|특별시|광역시|통합특별시|도)$/, '') : '';
    const label = dept == null ? '의원' : data.depts[dept];
    let big, line;
    if (!cl) {
      big = '없음';
      line = `${t.label} 인구 <b>${fmtN(ppl)}명</b>이 사는 지역인데 ${esc(label)}이 아직 없어요.`;
    } else {
      const per = ppl / cl;
      big = `${fmtN(per)}명`;
      if (avg && avg.per) {
        const ratio = per / avg.per;
        const word = ratio >= 1.2 ? `<b class="up">${sidoNm} 평균(${fmtN(avg.per)}명)보다 ${ratio.toFixed(1)}배 여유 있어요</b>`
          : ratio <= 0.83 ? `<b class="down">${sidoNm} 평균(${fmtN(avg.per)}명)보다 경쟁이 ${(1 / ratio).toFixed(1)}배 빽빽해요</b>`
          : `${sidoNm} 평균(${fmtN(avg.per)}명)과 <b>비슷해요</b>`;
        line = `${word}.`;
      } else line = `${esc(label)} 1곳이 ${t.label} 인구 ${fmtN(per)}명을 맡는 셈이에요.`;
    }
    const fs = P.femShare(dept);
    const fem = fs != null ? `<p class="pfem">${t.label} 중 여성 <b>${pct(fs)}</b>${avg && avg.femShare ? ` · ${sidoNm} 평균 ${pct(avg.femShare)}` : ''}</p>` : '';
    return `<div class="popcard">
      <div class="phead"><span>${esc(label)} 1곳당 ${t.label} 인구</span><b>${big}</b></div>
      <p class="pline">${line}</p>${fem}
      <p class="pmeta">행정동 ${P.dongs}곳 · ${t.label} 인구 ${fmtN(ppl)}명 · ${esc(label)} ${cl.toLocaleString()}곳 기준</p>
    </div>`;
  }

  function update() {
    since = sinceOf(yr);
    const rows = inBounds();
    const D = data.depts;

    // 진료과별 집계
    const by = new Map();
    for (const r of rows) {
      const k = r[2];
      const e = by.get(k) || { a: 0, n: 0, c: 0 };
      if (isActive(r)) e.a++;
      if (isNew(r)) e.n++;
      if (isClosed(r)) e.c++;
      by.set(k, e);
    }
    const list = [...by.entries()].filter(([, e]) => e.a || e.c).sort((x, y) => y[1].a - x[1].a);

    if (dept != null && !by.has(dept)) dept = null;
    const pick = dept == null ? rows : rows.filter((r) => r[2] === dept);
    const A = pick.filter(isActive).length, N = pick.filter(isNew).length, C = pick.filter(isClosed).length;
    const label = dept == null ? '전체 의원' : D[dept];

    $('title').textContent = dept == null ? '지금 보고 있는 지역' : `지금 보고 있는 지역 · ${D[dept]}`;
    $('chips').innerHTML = [`<button data-dept="" aria-pressed="${dept == null}">전체</button>`]
      .concat(list.slice(0, 15).map(([k]) => `<button data-dept="${k}" aria-pressed="${dept === k}">${esc(D[k])}</button>`)).join('');

    const P = pop ? popStats() : null;
    $('popcard').innerHTML = P ? popCard(P) : '';
    const perCol = (k) => {
      if (!P || !P.dongs) return '–';
      const c = P.clinics(k); if (!c) return '–';
      const v = P.people(k) / c, a = P.sido != null ? sidoAvg(P.sido, k).per : null;
      const cls = a ? (v / a >= 1.2 ? 'up' : v / a <= 0.83 ? 'down' : '') : '';
      return `<span class="${cls}">${v >= 10000 ? (v / 10000).toFixed(1) + '만' : fmtN(v)}</span>`;
    };

    const net = N - C;
    const per = yr === 1 ? '최근 1년' : '최근 3년';
    $('sum').innerHTML = `
      <div><b>${A.toLocaleString()}</b><span>영업 중</span></div>
      <div class="n"><b>+${N.toLocaleString()}</b><span>${per} 개원</span></div>
      <div class="c"><b>−${C.toLocaleString()}</b><span>${per} 폐업</span></div>`;
    $('verdict').innerHTML = A || C ? `${per}, 이 지역 ${esc(label)} 수는 <b>${net > 0 ? `${net}곳 늘었어요` : net < 0 ? `${-net}곳 줄었어요` : '그대로예요'}</b>.` : '';

    $('depts').innerHTML = list.length ? `<li><div class="drow head"><span>진료과</span><span class="v">영업</span><span class="v">개원</span><span class="v">폐업</span><span class="v">1곳당</span></div></li>`
      + list.map(([k, e]) => `<li><button class="drow" data-dept="${k}" aria-pressed="${dept === k}">
        <b>${esc(D[k])}</b><span class="v">${e.a}</span><span class="v n">${e.n ? '+' + e.n : '–'}</span><span class="v c">${e.c ? '−' + e.c : '–'}</span><span class="v p">${perCol(k)}</span></button></li>`).join('')
      : '<li><p class="empty">이 지역에는 의원이 없어요. 지도를 옮기거나 축소해 보세요.</p></li>';

    drawDots(pick);
  }

  function drawDots(rows) {
    hideTip();
    overlays.forEach((o) => o.setMap(null));
    overlays = [];
    const show = map.getLevel() <= DOT_LEVEL && rows.length <= MAX_DOTS;
    $('zoomhint').hidden = show || !rows.length;
    if (!show) return;
    for (const r of rows) {
      if (!isActive(r) && !(showClosed && isClosed(r))) continue;
      const el = document.createElement('div');
      el.className = `dot ${isClosed(r) ? 'cls' : isNew(r) ? 'new' : ''}`;
      el.addEventListener('click', (ev) => { ev.stopPropagation(); showTip(r, el); });
      const o = new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(r[0], r[1]), content: el, zIndex: isNew(r) ? 3 : 2 });
      o.setMap(map);
      overlays.push(o);
    }
  }

  // 점 위에 뜨는 정보 말풍선
  let tip = null, popAt = 0;
  function hideTip() {
    if (tip) { tip.setMap(null); tip = null; }
    document.querySelectorAll('.dot.on').forEach((d) => d.classList.remove('on'));
  }
  function showTip(r, dotEl) {
    hideTip();
    const wrap = document.createElement('div');
    wrap.className = 'popwrap';
    wrap.innerHTML = `<div class="pop" role="dialog"><b>${esc(r[5])}</b><span>${esc(data.depts[r[2]])} · ${r[4] ? `${fmtD(r[4])} 폐업` : `${fmtD(r[3])} 개원`}</span></div>`;
    wrap.addEventListener('click', (ev) => ev.stopPropagation());
    tip = new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(r[0], r[1]), content: wrap, xAnchor: 0.5, yAnchor: 1, zIndex: 20 });
    tip.setMap(map);
    dotEl.classList.add('on');
    popAt = Date.now();
  }

  function bind() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-dept],[data-yr]');
      if (!t) return;
      if (t.dataset.yr) {
        yr = +t.dataset.yr;
        document.querySelectorAll('[data-yr]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
      } else {
        const v = t.dataset.dept;
        dept = v === '' || +v === dept ? null : +v;
      }
      update();
    });
    $('clsToggle').addEventListener('click', (e) => {
      e.stopPropagation();
      showClosed = !showClosed;
      $('clsToggle').setAttribute('aria-pressed', String(showClosed));
      update();
    });
    $('search').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = $('q').value.trim();
      if (!q) return;
      new kakao.maps.services.Places().keywordSearch(q, (res, status) => {
        if (status !== kakao.maps.services.Status.OK || !res.length) { $('q').value = ''; $('q').placeholder = '찾지 못했어요. 다른 이름으로 검색해 보세요'; return; }
        map.setLevel(4);
        map.setCenter(new kakao.maps.LatLng(+res[0].y, +res[0].x));
        $('q').blur();
      });
    });
  }

  async function start() {
    try {
      const [json] = await Promise.all([fetch('data/clinics.json', { cache: 'no-cache' }).then((r) => {
        if (!r.ok) throw new Error('데이터 파일이 없어요.'); return r.json();
      }), loadKakao()]);
      data = json;
      try {
        const pr = await fetch('data/dongs.json', { cache: 'no-cache' });
        if (pr.ok) { pop = await pr.json(); assignHomes(); }
      } catch (e) { pop = null; }
      $('stamp').textContent = `${fmtD(data.dataDate)} 기준 인허가 데이터 · 영업 중 의원 ${data.rows.filter(isActive).length.toLocaleString()}곳${pop ? ` · 인구 ${pop.month.slice(0, 4)}.${pop.month.slice(4)} 기준` : ''}`;
      map = new kakao.maps.Map($('map'), { center: new kakao.maps.LatLng(37.4979, 127.0276), level: 5 });
      kakao.maps.event.addListener(map, 'idle', update);
      // 지도 빈 곳을 누르거나, 끌거나, 확대·축소하면 말풍선 닫기
      kakao.maps.event.addListener(map, 'click', () => { if (Date.now() - popAt > 300) hideTip(); });
      kakao.maps.event.addListener(map, 'dragstart', hideTip);
      kakao.maps.event.addListener(map, 'zoom_start', hideTip);
      document.addEventListener('click', (e) => { if (!e.target.closest('.popwrap,.dot') && Date.now() - popAt > 300) hideTip(); });
      bind();
      update();
    } catch (e) {
      $('stamp').textContent = `${e.message} 잠시 후 다시 열어주세요.`;
    }
  }
  start();
})();
