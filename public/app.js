(() => {
  const KAKAO_KEY = '6afa60c134993264035a6862fb568f78'; // 등록한 도메인에서만 작동
  const qs = new URLSearchParams(location.search);
  if (qs.get('theme')) document.documentElement.dataset.theme = qs.get('theme');

  const $ = (id) => document.getElementById(id);
  const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_DOTS = 900;   // 이보다 많으면 점은 안 그리고 숫자만
  const DOT_LEVEL = 5;    // 이 레벨 이하(더 확대)일 때 점 표시

  let data, map, overlays = [], yr = 1, dept = null, since = 0, showClosed = false;

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

    const net = N - C;
    const per = yr === 1 ? '최근 1년' : '최근 3년';
    $('sum').innerHTML = `
      <div><b>${A.toLocaleString()}</b><span>영업 중</span></div>
      <div class="n"><b>+${N.toLocaleString()}</b><span>${per} 개원</span></div>
      <div class="c"><b>−${C.toLocaleString()}</b><span>${per} 폐업</span></div>`;
    $('verdict').innerHTML = A || C ? `${per}, 이 지역 ${esc(label)} 수는 <b>${net > 0 ? `${net}곳 늘었어요` : net < 0 ? `${-net}곳 줄었어요` : '그대로예요'}</b>.` : '';

    $('depts').innerHTML = list.length ? `<li><div class="drow head"><span>진료과</span><span class="v">영업</span><span class="v">개원</span><span class="v">폐업</span></div></li>`
      + list.map(([k, e]) => `<li><button class="drow" data-dept="${k}" aria-pressed="${dept === k}">
        <b>${esc(D[k])}</b><span class="v">${e.a}</span><span class="v n">${e.n ? '+' + e.n : '–'}</span><span class="v c">${e.c ? '−' + e.c : '–'}</span></button></li>`).join('')
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
  let pop = null, popAt = 0;
  function hideTip() {
    if (pop) { pop.setMap(null); pop = null; }
    document.querySelectorAll('.dot.on').forEach((d) => d.classList.remove('on'));
  }
  function showTip(r, dotEl) {
    hideTip();
    const wrap = document.createElement('div');
    wrap.className = 'popwrap';
    wrap.innerHTML = `<div class="pop" role="dialog"><b>${esc(r[5])}</b><span>${esc(data.depts[r[2]])} · ${r[4] ? `${fmtD(r[4])} 폐업` : `${fmtD(r[3])} 개원`}</span></div>`;
    wrap.addEventListener('click', (ev) => ev.stopPropagation());
    pop = new kakao.maps.CustomOverlay({ position: new kakao.maps.LatLng(r[0], r[1]), content: wrap, xAnchor: 0.5, yAnchor: 1, zIndex: 20 });
    pop.setMap(map);
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
      $('stamp').textContent = `${fmtD(data.dataDate)} 기준 인허가 데이터 · 영업 중 의원 ${data.rows.filter(isActive).length.toLocaleString()}곳`;
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
