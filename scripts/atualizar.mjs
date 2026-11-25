// Robô do Quanto Choveu: busca previsão/estimativa (Open-Meteo) e chuva medida (Cemaden)
// e grava dados.json, publicado junto com o site pelo GitHub Actions.
import fs from 'node:fs';

const CITIES = JSON.parse(fs.readFileSync(new URL('./cidades.json', import.meta.url), 'utf8'));
const OUT = process.argv[2] || 'dados.json';
const OUT_CAD = OUT.replace(/dados\.json$/, 'cadastro.json');
const wait = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function openMeteo() {
  const url = part => 'https://api.open-meteo.com/v1/forecast?latitude=' + part.map(c => c[1]).join(',') +
    '&longitude=' + part.map(c => c[2]).join(',') +
    '&hourly=precipitation,temperature_2m,precipitation_probability,weather_code,is_day&daily=precipitation_sum,precipitation_probability_max,temperature_2m_max,temperature_2m_min,weather_code' +
    '&current=temperature_2m,precipitation,weather_code,is_day&past_days=7&forecast_days=7&timezone=America%2FSao_Paulo';
  const out = [];
  for (let i = 0; i < CITIES.length; i += 20) {
    const part = CITIES.slice(i, i + 20);
    for (let t = 0; ; t++) {
      const r = await fetch(url(part));
      if (r.ok) { const j = await r.json(); out.push(...(Array.isArray(j) ? j : [j])); break; }
      log('open-meteo', r.status, 'tentativa', t + 1);
      if (t >= 4) throw new Error('Open-Meteo HTTP ' + r.status);
      await wait(3000 * 2 ** t);
    }
  }
  return out;
}

async function cemaden() {
  const email = process.env.CEMADEN_EMAIL, senha = process.env.CEMADEN_SENHA;
  if (!email || !senha) { log('cemaden: sem credenciais, pulando'); return null; }
  const r = await fetch('https://sgaa.cemaden.gov.br/SGAA/rest/controle-token/tokens', {
    method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
    body: JSON.stringify({email, password: senha})
  });
  const txt = await r.text();
  let tok = null, j = null;
  try { j = JSON.parse(txt); } catch (e) {}
  if (j) {
    const o = Array.isArray(j) ? j[0] || {} : j;
    tok = o.token || o.access_token || o.jwt || null;
    log('cemaden login', r.status, 'campos:', Object.keys(o).join(','));
  } else if (txt.trim().split('.').length === 3) tok = txt.trim();
  if (!tok) { log('cemaden: login falhou', r.status, txt.slice(0, 200).split(senha).join('***')); return null; }
  const H = {token: tok, Accept: 'application/json'};
  const BASE = 'https://sws.cemaden.gov.br/PED/rest';
  await wait(5500);
  const rr = await fetch(BASE + '/pcds/pcds-dados-recentes?rede=11&uf=ES&formato=JSON', {headers: H});
  const rec = rr.ok ? await rr.json() : [];
  log('cemaden recentes', rr.status, Array.isArray(rec) ? rec.length + ' leituras' : typeof rec);
  const last = {}, meta = {};
  for (const x of Array.isArray(rec) ? rec : []) {
    if (!last[x.codestacao] || x.datahora > last[x.codestacao]) last[x.codestacao] = x.datahora;
    meta[x.codestacao] = {nome: x.nome, cidade: x.cidade, lat: x.latitude, lon: x.longitude};
  }
  const ibges = [...new Set(Object.keys(last).map(c => c.slice(0, 7)))];
  log('cemaden municipios com estacao ativa:', ibges.length);
  const acum = [];
  for (const ib of ibges) {
    await wait(5500);
    const a = await fetch(BASE + '/pcds-acum/acumulados-recentes?codibge=' + ib + '&formato=JSON', {headers: H});
    const t = await a.text();
    let d = null; try { d = JSON.parse(t); } catch (e) {}
    if (!a.ok || !d) { log('cemaden acum falhou', ib, a.status, t.slice(0, 120)); continue; }
    const arr = Array.isArray(d) ? d : [d];
    if (!acum.length && arr[0]) log('cemaden acum exemplo:', JSON.stringify(arr[0]).slice(0, 700));
    for (const x of arr) {
      if (!last[x.codestacao]) continue;
      const m = meta[x.codestacao] || {};
      acum.push({cod: x.codestacao, ibge: x.codibge, nome: m.nome, cidade: m.cidade, lat: m.lat, lon: m.lon, ultima: last[x.codestacao],
        a1: x.acc1hr, a3: x.acc3hr, a6: x.acc6hr, a12: x.acc12hr, a24: x.acc24hr, a48: x.acc48hr, a72: x.acc72hr, a96: x.acc96hr, a120: x.acc120hr});
    }
  }
  log('cemaden estacoes ativas com acumulado:', acum.length);
  try { await cadastro(H, BASE, meta); } catch (e) { log('cadastro erro', e.message); }
  return {at: Date.now(), fonte: 'Cemaden/MCTI', estacoes: acum};
}

// Cadastro de todas as estações do ES (inclusive paradas), com coordenadas.
// Muda pouco: reaproveita o publicado no site e só refaz uma vez por semana.
async function cadastro(H, BASE, meta) {
  // O cadastro do Cemaden não traz coordenadas: guardamos as que aparecem no feed de leituras.
  let prev = null;
  try { const r = await fetch('https://quantochoveu.com.br/cadastro.json', {cache: 'no-store'}); if (r.ok) prev = await r.json(); } catch (e) {}
  const pos = {};
  for (const s of (prev && prev.estacoes) || []) if (s.lat != null) pos[s.cod] = [s.lat, s.lon];
  for (const [cod, m] of Object.entries(meta || {})) { const la = +m.lat, lo = +m.lon; if (isFinite(la) && isFinite(lo) && la && lo) pos[cod] = [la, lo]; }
  const put = o => { for (const s of o.estacoes) if (pos[s.cod]) [s.lat, s.lon] = pos[s.cod]; fs.writeFileSync(OUT_CAD, JSON.stringify(o)); };
  if (prev && prev.estacoes && prev.estacoes.length && Date.now() - prev.at < 7 * 864e5) {
    put(prev); log('cadastro reaproveitado:', prev.estacoes.length, 'estacoes'); return;
  }
  await wait(5500);
  const rc = await fetch(BASE + '/pcds-cadastro/cidades?uf=ES&formato=JSON', {headers: H});
  const cidades = rc.ok ? await rc.json() : [];
  if (!Array.isArray(cidades) || !cidades.length) { log('cadastro: lista de cidades vazia', rc.status); if (prev) put(prev); return; }
  const est = [];
  for (const c of cidades) {
    const ib = c.codibge || c.cod_ibge || c.ibge;
    if (!ib) continue;
    await wait(5500);
    const r = await fetch(BASE + '/pcds-cadastro/estacoes?codibge=' + ib + '&formato=JSON', {headers: H});
    let d = null; try { d = await r.json(); } catch (e) {}
    if (!r.ok || !d) { log('cadastro falhou', ib, r.status); continue; }
    for (const x of Array.isArray(d) ? d : [d]) {
      if (!x || !x.codestacao) continue;
      const lat = +(x.latitude ?? x.lat), lon = +(x.longitude ?? x.lon);
      if (isFinite(lat) && isFinite(lon) && lat && lon) pos[x.codestacao] = [lat, lon];
      est.push({cod: x.codestacao, nome: x.nome || x.nomeestacao || null, cidade: c.cidade || x.cidade || null,
        tipo: x.id_tipoestacao === 1 ? 'pluviometrica' : 'tipo ' + x.id_tipoestacao});
    }
  }
  if (est.length) { put({at: Date.now(), estacoes: est}); log('cadastro novo:', est.length, 'estacoes,', est.filter(s => s.lat != null).length, 'com coordenadas'); }
  else if (prev) put(prev);
}

// Previsão por conjunto de modelos: guarda a chuva hora a hora de 5 modelos (refeito a cada 6 horas,
// que é o ritmo em que os modelos são atualizados) e calcula a mediana para o site.
const MODELS = ['ecmwf_ifs025', 'gfs_seamless', 'icon_seamless', 'gem_seamless', 'jma_seamless'];
const OUT_ENS = OUT.replace(/dados\.json$/, 'conjunto.json');
async function getJSON(u) { try { const r = await fetch(u, {cache: 'no-store'}); if (r.ok) return await r.json(); } catch (e) {} return null; }
async function conjunto() {
  const prev = await getJSON('https://quantochoveu.com.br/conjunto.json');
  if (prev && prev.cidades && prev.cidades.length === CITIES.length && Date.now() - prev.at < 6 * 3600e3) {
    fs.writeFileSync(OUT_ENS, JSON.stringify(prev)); log('conjunto reaproveitado de', new Date(prev.at).toISOString()); return prev;
  }
  const url = part => 'https://api.open-meteo.com/v1/forecast?latitude=' + part.map(c => c[1]).join(',') +
    '&longitude=' + part.map(c => c[2]).join(',') + '&hourly=precipitation&models=' + MODELS.join(',') +
    '&forecast_days=8&timezone=America%2FSao_Paulo';
  const cidades = [];
  for (let i = 0; i < CITIES.length; i += 20) {
    const part = CITIES.slice(i, i + 20);
    let j = null;
    for (let t = 0; ; t++) {
      const r = await fetch(url(part));
      if (r.ok) { j = await r.json(); break; }
      log('conjunto open-meteo', r.status, 'tentativa', t + 1);
      if (t >= 4) throw new Error('Open-Meteo HTTP ' + r.status);
      await wait(3000 * 2 ** t);
    }
    for (const x of Array.isArray(j) ? j : [j]) {
      const m = {};
      for (const md of MODELS) { const a = x.hourly['precipitation_' + md]; if (a) m[md] = a.map(v => v == null ? null : Math.round(v * 10) / 10); }
      cidades.push({t0: x.hourly.time[0], m});
    }
    await wait(1500);
  }
  const o = {at: Date.now(), modelos: MODELS, cidades};
  fs.writeFileSync(OUT_ENS, JSON.stringify(o)); log('conjunto novo', cidades.length, 'cidades');
  return o;
}
const median = a => { const v = a.filter(x => x != null && isFinite(x)).sort((p, q) => p - q); if (!v.length) return null; const h = v.length >> 1; return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2; };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const hourStr = ms => new Date(ms - 3 * 3600e3).toISOString().slice(0, 13) + ':00'; // horário de Brasília
const addH = (t, h) => hourStr(Date.parse(t + ':00Z') + 3 * 3600e3 + h * 3600e3);
// Resume o conjunto para a hora atual: mediana hora a hora, das próximas 24 horas, dos próximos 7 dias e por dia.
function resumo(ens) {
  if (!ens) return null;
  const now = hourStr(Date.now()), today = now.slice(0, 10);
  const end7 = addH(today + 'T00:00', 7 * 24); // fim do 7º dia contando hoje
  return ens.cidades.map(c => {
    const t0 = Date.parse(c.t0 + ':00Z'), idx = t => Math.round((Date.parse(t + ':00Z') - t0) / 3600e3);
    const k = idx(now), k7 = idx(end7), M = Object.values(c.m);
    if (k < 0 || !M.length) return null;
    const sum = (a, i, j) => { let s = 0, n = 0; for (let x = i; x < j && x < a.length; x++) if (a[x] != null) { s += a[x]; n++; } return n ? s : null; };
    const h = {};
    for (let x = 0; x <= 24; x++) h[addH(now, x)] = r1(median(M.map(a => a[k + x])));
    const d = {};
    for (let dd = 1; dd <= 7; dd++) {
      const t = addH(today + 'T00:00', dd * 24), i = idx(t);
      const v = median(M.map(a => sum(a, i, i + 24)));
      if (v != null) d[t.slice(0, 10)] = r1(v);
    }
    const n7s = M.map(a => sum(a, k + 1, k7)).filter(v => v != null);
    return {h, n24: r1(median(M.map(a => sum(a, k + 1, k + 25)))), n7: r1(median(n7s)), r7: n7s.length ? [r1(Math.min(...n7s)), r1(Math.max(...n7s))] : null, d};
  });
}

// Histórico para medir o acerto: guarda a previsão de amanhã de cada modelo e, no dia seguinte, a chuva medida.
const HIST = 'historico/previsoes.json';
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const distKm = (a, b, c, d) => { const R = x => x * Math.PI / 180, q = Math.sin(R(c - a) / 2) ** 2 + Math.cos(R(a)) * Math.cos(R(c)) * Math.sin(R(d - b) / 2) ** 2; return 12742 * Math.asin(Math.sqrt(q)); };
function historico(om, ens, cm) {
  let H = {previsao: {}, medido: {}};
  try { H = JSON.parse(fs.readFileSync(HIST, 'utf8')); } catch (e) {}
  const now = hourStr(Date.now()), today = now.slice(0, 10), hr = +now.slice(11, 13);
  const tomorrow = addH(today + 'T00:00', 24).slice(0, 10), yesterday = addH(today + 'T00:00', -24).slice(0, 10);
  let changed = false;
  if (hr >= 9 && !H.previsao[tomorrow] && ens && om) {
    const rec = {};
    CITIES.forEach((c, i) => {
      const e = ens.cidades[i], r = om[i];
      if (!e || !r) return;
      const t0 = Date.parse(e.t0 + ':00Z'), a = Math.round((Date.parse(tomorrow + 'T00:00:00Z') - t0) / 3600e3);
      const o = {};
      for (const [md, arr] of Object.entries(e.m)) { const s = arr.slice(a, a + 24); if (s.length === 24 && s.every(v => v != null)) o[md] = r1(s.reduce((p, q) => p + q, 0)); }
      o.mediana = r1(median(Object.values(o)));
      const di = r.daily.time.indexOf(tomorrow); if (di >= 0) o.best_match = r1(r.daily.precipitation_sum[di]);
      rec[c[0]] = o;
    });
    H.previsao[tomorrow] = {feito: new Date().toISOString(), cidades: rec}; changed = true; log('historico: previsao de', tomorrow);
  }
  if (hr <= 2 && !H.medido[yesterday] && cm && cm.estacoes && cm.estacoes.length) {
    const rec = {};
    for (const c of CITIES) {
      let best = null, bd = Infinity; const todas = {};
      for (const s of cm.estacoes) {
        if (norm(s.cidade) !== norm(c[0]) || s.a24 == null || s.a24 < 0 || s.a24 > 600) continue;
        if (!(cm.at - Date.parse(String(s.ultima).replace(' ', 'T') + 'Z') < 3 * 3600e3)) continue;
        todas[s.cod] = r1(+s.a24);
        const d = s.lat != null ? distKm(c[1], c[2], +s.lat, +s.lon) : 50;
        if (d < bd) { bd = d; best = s; }
      }
      if (best) rec[c[0]] = {mm: r1(+best.a24), estacao: best.cod, todas};
    }
    H.medido[yesterday] = {feito: new Date().toISOString(), obs: 'acumulado de 24 horas lido logo após a meia-noite', cidades: rec}; changed = true; log('historico: medido de', yesterday, Object.keys(rec).length, 'cidades');
  }
  if (changed) { fs.mkdirSync('historico', {recursive: true}); fs.writeFileSync(HIST, JSON.stringify(H, null, 1)); }
  return H;
}

// Chuva medida em 7 dias: o Cemaden só informa até 120 horas (5 dias). Os 2 dias que faltam vêm do nosso
// histórico diário (total do dia lido à meia-noite, proporcional às horas da janela); onde ainda não houver
// histórico, entram as horas estimadas pelo modelo. m7e diz quantas das 48 horas foram estimadas.
function medido7(cm, om, H) {
  if (!cm || !cm.estacoes) return;
  const now = Date.now(), ini = now - 168 * 3600e3, fim = now - 120 * 3600e3;
  const idx = new Map(CITIES.map((c, i) => [norm(c[0]), i]));
  for (const s of cm.estacoes) {
    if (s.a120 == null || s.a120 < 0 || s.a120 > 2000) continue;
    const i = idx.get(norm(s.cidade)), r = om && i != null ? om[i] : null;
    let extra = 0, est = 0;
    for (let t = ini; t < fim; t += 3600e3) {
      const loc = hourStr(t), dia = loc.slice(0, 10);
      const reg = H && H.medido && H.medido[dia] && H.medido[dia].cidades[CITIES[i] ? CITIES[i][0] : ''];
      const v = reg ? (reg.todas && reg.todas[s.cod] != null ? reg.todas[s.cod] : reg.estacao === s.cod ? reg.mm : null) : null;
      if (v != null) { extra += v / 24; continue; }
      est++;
      if (r) { const k = r.hourly.time.indexOf(loc); if (k >= 0) extra += r.hourly.precipitation[k] || 0; }
    }
    s.m7 = r1(+s.a120 + extra); s.m7e = est;
  }
}


// ---------- Outras redes públicas de pluviômetros ----------
// SATDES (Incaper): Defesa Civil (CEPDEC) e Inmet, com a soma da chuva por estação em qualquer janela.
// ANA (telemetria): todas as estações telemétricas do ES, direto da ANA.
const brt = ms => new Date(ms - 3 * 3600e3).toISOString().slice(0, 16); // AAAA-MM-DDTHH:MM no horário de Brasília
const tmo = (u, o = {}, ms = 25000) => fetch(u, {...o, signal: AbortSignal.timeout(ms)});
const titulo = s => String(s || '').toLowerCase().replace(/(^|[\s\-(\/])([a-zà-ú])/g, (m, a, b) => a + b.toUpperCase()).replace(/\b(De|Da|Do|Das|Dos|E)\b/g, w => w.toLowerCase());

async function satdes() {
  const B = 'https://satdes.incaper.es.gov.br/api/v1';
  const st = await (await tmo(B + '/stations')).json();
  const info = {}; for (const s of st.data || []) info[s.id] = s;
  const now = Date.now(), fim = brt(now);
  const soma = async h => {
    const r = await tmo(B + '/records/monitoring/map/' + brt(now - h * 3600e3) + '/' + fim, {}, 60000);
    if (!r.ok) throw new Error('SATDES HTTP ' + r.status);
    const d = (await r.json()).data || {};
    const g = Object.values(d).find(x => x && typeof x === 'object' && /precip/i.test((Object.values(x)[0] || {}).variable_name || ''));
    return g || {};
  };
  const W = {};
  for (const h of [1, 24, 72, 120]) { W[h] = await soma(h); await wait(800); }
  const out = [];
  for (const [id, x] of Object.entries(W[24])) {
    const i = info[x.id_station] || {}, inst = String(x.code || '').split('_')[0];
    if (inst === 'ANA') continue; // a ANA vem direto da fonte: no SATDES parte das leituras dela aparece duplicada
    const lr = x.last_record && x.last_record.date; if (!lr) continue;
    const [dd, mm, yy, hh, mi] = lr.match(/\d+/g) || [];
    const ultima = new Date(Date.UTC(+yy, +mm - 1, +dd, +hh + 3, +mi)).toISOString().slice(0, 19).replace('T', ' ');
    const v = h => { const y = W[h][id]; return y && y.aggregate_records && y.aggregate_records.sum_value != null ? r1(+y.aggregate_records.sum_value) : null; };
    const fonte = inst === 'CEP' ? 'Defesa Civil' : inst === 'INM' ? 'Inmet' : inst === 'ANA' ? 'ANA' : inst === 'INC' ? 'Incaper' : inst;
    const lugar = i.name_district ? titulo(i.name_district) : '';
    out.push({cod: 'SAT-' + x.code, ana: inst === 'ANA' ? String(x.name) : null, fonte, nome: lugar || (fonte === 'Inmet' ? 'Estação ' + x.name : 'Estação automática'),
      cidade: i.name_county || '', lat: x.latitude, lon: x.longitude, ultima, a1: v(1), a24: v(24), a72: v(72), a120: v(120)});
  }
  const c = {}; out.forEach(s => c[s.fonte] = (c[s.fonte] || 0) + 1);
  log('satdes: estacoes com chuva', out.length, JSON.stringify(c));
  return out;
}

const xmlRows = (t, tag) => [...t.matchAll(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'g'))].map(m => {
  const o = {}; for (const k of m[1].matchAll(/<([A-Za-z\-]+)>([^<]*)<\/\1>/g)) o[k[1]] = k[2].trim(); return o;
});
async function anaLista() {
  const F = 'historico/ana-estacoes.json';
  try { const p = JSON.parse(fs.readFileSync(F, 'utf8')); if (Date.now() - p.at < 7 * 864e5) return p.estacoes; } catch (e) {}
  const r = await tmo('https://telemetriaws1.ana.gov.br/ServiceANA.asmx/ListaEstacoesTelemetricas?statusEstacoes=0&origem=', {}, 120000);
  if (!r.ok) throw new Error('ANA lista HTTP ' + r.status);
  const seen = new Set(), est = [];
  for (const o of xmlRows(await r.text(), 'Table')) {
    if (!/-ES$/.test(o['Municipio-UF'] || '') || seen.has(o.CodEstacao)) continue;
    seen.add(o.CodEstacao);
    est.push({cod: o.CodEstacao, nome: o.NomeEstacao, cidade: o['Municipio-UF'].replace(/-ES$/, ''), lat: +o.Latitude, lon: +o.Longitude});
  }
  fs.mkdirSync('historico', {recursive: true}); fs.writeFileSync(F, JSON.stringify({at: Date.now(), estacoes: est}));
  log('ana: lista nova', est.length, 'estacoes no ES');
  return est;
}
// Nomes de município como a ANA escreve -> como o site usa.
function cidadeANA(n) {
  const t = String(n || '');
  if (/reg[eê]ncia/i.test(t)) return 'Linhares'; // Regência é distrito de Linhares
  const base = norm(t.replace(/\s*\(.*?\)\s*/g, ' ').trim()).replace(/ do itapemirim$/, ' de itapemirim');
  const c = CITIES.find(x => norm(x[0]) === base);
  return c ? c[0] : t;
}
async function ana(prev, pular) {
  const velhas = ((prev && prev.estacoes) || []).filter(s => s.fonte === 'ANA' && !s.cod.startsWith('SAT-'));
  velhas.forEach(s => s.cidade = cidadeANA(s.cidade));
  if (prev && prev.anaAt && Date.now() - prev.anaAt < 25 * 60e3) { log('ana: reaproveitado', velhas.length); return {at: prev.anaAt, est: velhas}; }
  const lista = (await anaLista()).filter(s => !pular.has(s.cod));
  const now = Date.now(), d0 = new Date(now - 3 * 3600e3 - 6 * 864e5), d1 = new Date(now - 3 * 3600e3 + 864e5);
  const dt = d => String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
  const out = []; let i = 0;
  const um = async s => {
    try {
      const r = await tmo('https://telemetriaws1.ana.gov.br/ServiceANA.asmx/DadosHidrometeorologicos?codEstacao=' + s.cod + '&dataInicio=' + dt(d0) + '&dataFim=' + dt(d1), {}, 30000);
      if (!r.ok) return;
      const rows = xmlRows(await r.text(), 'DadosHidrometereologicos').filter(o => o.Chuva !== undefined && o.Chuva !== '' && isFinite(+o.Chuva));
      if (!rows.length) return;
      const pts = rows.map(o => ({t: Date.parse(o.DataHora.replace(' ', 'T') + '-03:00'), v: +o.Chuva})).filter(p => isFinite(p.t));
      if (pts.some(p => p.v < 0 || p.v > 150)) return; // série estranha (acumulador ou erro): fica de fora
      const last = Math.max(...pts.map(p => p.t));
      const sum = h => r1(pts.filter(p => p.t > now - h * 3600e3 && p.t <= now).reduce((a, p) => a + p.v, 0));
      out.push({cod: 'ANA-' + s.cod, fonte: 'ANA', nome: titulo(s.nome), cidade: cidadeANA(s.cidade), lat: s.lat, lon: s.lon,
        ultima: new Date(last).toISOString().slice(0, 19).replace('T', ' '), a1: sum(1), a24: sum(24), a72: sum(72), a120: sum(120)});
    } catch (e) {}
  };
  await Promise.all(Array.from({length: 6}, async () => { while (i < lista.length) await um(lista[i++]); }));
  log('ana: estacoes com chuva', out.length, 'de', lista.length);
  return {at: Date.now(), est: out};
}

// Alertas do Inmet (lista pública de avisos ativos): guarda só os que pegam municípios do ES.
async function alertas() {
  const r = await fetch('https://apiprevmet3.inmet.gov.br/avisos/ativos', {headers: {Accept: 'application/json'}});
  if (!r.ok) throw new Error('Inmet HTTP ' + r.status);
  const j = await r.json();
  const nomes = new Map(CITIES.map(c => [norm(c[0]), c[0]]));
  const lista = Object.values(j).filter(Array.isArray).flat();
  const txt = v => Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean) : String(v || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const out = [], vistos = new Set();
  for (const a of lista) {
    const cid = [];
    for (const m of String(a.municipios || '').split(/,(?=[^,]+ - [A-Z]{2} \(\d{7}\))/)) {
      const k = m.match(/^\s*(.+?) - ([A-Z]{2}) \((\d{7})\)\s*$/);
      if (k && k[2] === 'ES') { const n = nomes.get(norm(k[1])); if (n) cid.push(n); }
    }
    if (!cid.length) continue;
    const id = a.id || a.codigo; if (vistos.has(id)) continue; vistos.add(id);
    const ini = String(a.data_inicio || a.inicio || '').slice(0, 10) + 'T' + (a.hora_inicio || '00:00');
    const fim = String(a.data_fim || a.fim || '').slice(0, 10) + 'T' + (a.hora_fim || '23:59');
    if (Date.parse(fim + ':00-03:00') < Date.now()) continue;
    out.push({id, evento: a.descricao || 'Alerta', severidade: a.severidade || '', cor: a.aviso_cor || '#F2C511', inicio: ini, fim,
      riscos: txt(a.riscos), instrucoes: txt(a.instrucoes), cidades: [...new Set(cid)]});
  }
  const peso = s => /grande/i.test(s) ? 3 : /potencial/i.test(s) ? 1 : /perigo/i.test(s) ? 2 : 0;
  out.sort((x, y) => peso(y.severidade) - peso(x.severidade) || x.inicio.localeCompare(y.inicio));
  log('inmet: alertas no ES', out.length);
  return {at: Date.now(), fonte: 'Inmet', avisos: out};
}

// Previsão base (Open-Meteo, melhor combinação): reaproveita a última por até 28 minutos para poupar a cota gratuita.
let om = null, omAt = null, cm = null, ens = null;
const prevD = await getJSON('https://quantochoveu.com.br/dados.json');
if (prevD && prevD.om && prevD.omAt && Date.now() - prevD.omAt < 28 * 60e3) { om = prevD.om; omAt = prevD.omAt; log('open-meteo reaproveitado'); }
else { try { om = await openMeteo(); omAt = Date.now(); log('open-meteo ok', om.length); } catch (e) { log('open-meteo erro', e.message); if (prevD && prevD.om) { om = prevD.om; omAt = prevD.omAt || prevD.at; } } }
try { ens = await conjunto(); } catch (e) { log('conjunto erro', e.message); }
try { cm = await cemaden(); } catch (e) { log('cemaden erro', e.message); }
if (cm) cm.estacoes.forEach(s => s.fonte = 'Cemaden');
{
  const extra = [];
  let sat = []; try { sat = await satdes(); } catch (e) { log('satdes erro', e.message); sat = ((prevD && prevD.cemaden && prevD.cemaden.estacoes) || []).filter(s => String(s.cod).startsWith('SAT-')); }
  extra.push(...sat);
  let anaAt = null;
  try { const a = await ana(prevD && prevD.cemaden, new Set()); extra.push(...a.est); anaAt = a.at; } catch (e) { log('ana erro', e.message); }
  if (!cm) cm = {at: Date.now(), fonte: 'Cemaden/MCTI', estacoes: []};
  cm.estacoes.push(...extra); cm.anaAt = anaAt;
  cm.fonte = 'Cemaden, Defesa Civil, Inmet e ANA';
  log('pluviometros no total', cm.estacoes.length);
}
let al = null; try { al = await alertas(); } catch (e) { log('alertas erro', e.message); if (prevD && prevD.alertas) al = prevD.alertas; }
let res = null; try { res = resumo(ens); } catch (e) { log('resumo erro', e.message); }
let H = null; try { H = historico(om, ens, cm); } catch (e) { log('historico erro', e.message); }
try { medido7(cm, om, H); } catch (e) { log('medido7 erro', e.message); }
fs.writeFileSync(OUT, JSON.stringify({at: Date.now(), omAt, om, ens: res, ensAt: ens ? ens.at : null, cemaden: cm, alertas: al}));
log('gravado', OUT, fs.statSync(OUT).size, 'bytes');
