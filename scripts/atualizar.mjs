// Robô do Quanto Choveu: busca previsão/estimativa (Open-Meteo) e chuva medida (Cemaden)
// e grava dados.json, publicado junto com o site pelo GitHub Actions.
import fs from 'node:fs';

const CITIES = JSON.parse(fs.readFileSync(new URL('./cidades.json', import.meta.url), 'utf8'));
const OUT = process.argv[2] || 'dados.json';
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
  const last = {};
  for (const x of Array.isArray(rec) ? rec : []) if (!last[x.codestacao] || x.datahora > last[x.codestacao]) last[x.codestacao] = x.datahora;
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
    for (const x of arr) acum.push({...x, ultima: last[x.codestacao] || null});
  }
  log('cemaden acumulados:', acum.length, 'estacoes');
  return {at: Date.now(), acumulados: acum};
}

let om = null, cm = null;
try { om = await openMeteo(); log('open-meteo ok', om.length); } catch (e) { log('open-meteo erro', e.message); }
try { cm = await cemaden(); } catch (e) { log('cemaden erro', e.message); }
fs.writeFileSync(OUT, JSON.stringify({at: Date.now(), om, cemaden: cm}));
log('gravado', OUT, fs.statSync(OUT).size, 'bytes');
