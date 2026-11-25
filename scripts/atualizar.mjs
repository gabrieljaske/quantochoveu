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
  try { await cadastro(H, BASE); } catch (e) { log('cadastro erro', e.message); }
  return {at: Date.now(), fonte: 'Cemaden/MCTI', estacoes: acum};
}

// Cadastro de todas as estações do ES (inclusive paradas), com coordenadas.
// Muda pouco: reaproveita o publicado no site e só refaz uma vez por semana.
async function cadastro(H, BASE) {
  let prev = null;
  try { const r = await fetch('https://quantochoveu.com.br/cadastro.json', {cache: 'no-store'}); if (r.ok) prev = await r.json(); } catch (e) {}
  if (prev && prev.estacoes && prev.estacoes.length && Date.now() - prev.at < 7 * 864e5) {
    fs.writeFileSync(OUT_CAD, JSON.stringify(prev)); log('cadastro reaproveitado:', prev.estacoes.length, 'estacoes'); return;
  }
  await wait(5500);
  const rc = await fetch(BASE + '/pcds-cadastro/cidades?uf=ES&formato=JSON', {headers: H});
  const cidades = rc.ok ? await rc.json() : [];
  if (!Array.isArray(cidades) || !cidades.length) { log('cadastro: lista de cidades vazia', rc.status); if (prev) fs.writeFileSync(OUT_CAD, JSON.stringify(prev)); return; }
  log('cadastro: cidades', cidades.length, 'exemplo', JSON.stringify(cidades[0]).slice(0, 200));
  const est = [];
  for (const c of cidades) {
    const ib = c.codibge || c.cod_ibge || c.ibge;
    if (!ib) continue;
    await wait(5500);
    const r = await fetch(BASE + '/pcds-cadastro/estacoes?codibge=' + ib + '&formato=JSON', {headers: H});
    let d = null; try { d = await r.json(); } catch (e) {}
    if (!r.ok || !d) { log('cadastro falhou', ib, r.status); continue; }
    const arr = Array.isArray(d) ? d : [d];
    if (!est.length && arr[0]) log('cadastro exemplo:', JSON.stringify(arr[0]).slice(0, 500));
    for (const x of arr) {
      const lat = +(x.latitude ?? x.lat), lon = +(x.longitude ?? x.lon);
      if (!isFinite(lat) || !isFinite(lon)) continue;
      est.push({cod: x.codestacao, nome: x.nome || x.nomeestacao || x.nome_estacao, cidade: x.cidade || x.municipio || c.cidade || c.nome,
        lat, lon, tipo: x.tipoestacao_descricao || x.tipoestacao || x.tipo || x.desc_tipo || null, inativo: x.dh_inicio_inativo || null});
    }
  }
  if (est.length) { fs.writeFileSync(OUT_CAD, JSON.stringify({at: Date.now(), estacoes: est})); log('cadastro novo:', est.length, 'estacoes'); }
  else if (prev) fs.writeFileSync(OUT_CAD, JSON.stringify(prev));
}

let om = null, cm = null;
try { om = await openMeteo(); log('open-meteo ok', om.length); } catch (e) { log('open-meteo erro', e.message); }
try { cm = await cemaden(); } catch (e) { log('cemaden erro', e.message); }
fs.writeFileSync(OUT, JSON.stringify({at: Date.now(), om, cemaden: cm}));
log('gravado', OUT, fs.statSync(OUT).size, 'bytes');
