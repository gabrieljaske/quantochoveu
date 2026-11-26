// Receptor do Quanto Choveu: recebe as leituras dos pluviômetros Ecowitt (upload "Customized", protocolo Ecowitt)
// e entrega um resumo para o robô do site.
//
// Rotas:
//   POST /ecowitt   o gateway Ecowitt manda os dados aqui (form-urlencoded, valores em polegadas)
//   GET  /dados     resumo por estação: última leitura, chuva de 1 h, 24 h, 72 h e do dia
//
// Cada aparelho se identifica pelo PASSKEY que ele mesmo envia. O robô do site só usa os PASSKEYs que
// estiverem cadastrados na lista de estações do site (nome, cidade e coordenadas ficam lá).
// Banco: D1 ligado como DB.

const IN = 25.4; // polegada -> mm

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, '');
    try {
      if (p === '/ecowitt') return await receber(req, env);
      if (p === '/dados') return await dados(env);
      if (p === '' || p === '/') return txt('Receptor do Quanto Choveu. Ok.');
      return txt('Não encontrado', 404);
    } catch (e) {
      return txt('Erro: ' + e.message, 500);
    }
  }
};

const txt = (s, status = 200) => new Response(s, {status, headers: {'content-type': 'text/plain; charset=utf-8'}});
const json = o => new Response(JSON.stringify(o), {headers: {'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store'}});

async function tabela(env) {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS leituras (estacao TEXT NOT NULL, t INTEGER NOT NULL, total REAL, dia REAL, taxa REAL, bateria TEXT, bruto TEXT, PRIMARY KEY (estacao, t))");
}

async function receber(req, env) {
  if (req.method !== 'POST') return txt('Use POST', 405);
  const f = Object.fromEntries((await req.formData()).entries());
  const estacao = String(f.PASSKEY || f.passkey || '').slice(0, 64);
  if (!/^[0-9A-Fa-f]{32}$/.test(estacao)) return txt('Sem PASSKEY', 400);
  // dateutc vem como "2026-12-08 13:45:00"
  const t = Date.parse(String(f.dateutc || '').replace(' ', 'T') + 'Z') || Date.now();
  const n = k => (f[k] !== undefined && f[k] !== '' && isFinite(+f[k])) ? +(+f[k] * IN).toFixed(2) : null;
  // WH40/WH40H: campos "tradicionais". Total acumulado do aparelho = totalrainin (ou yearlyrainin se não houver).
  const total = n('totalrainin') ?? n('yearlyrainin');
  const dia = n('dailyrainin'), taxa = n('rainratein');
  const bateria = f.wh40batt ?? f.wh40_batt ?? null;
  await tabela(env);
  await env.DB.prepare('INSERT OR REPLACE INTO leituras (estacao, t, total, dia, taxa, bateria, bruto) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(estacao, t, total, dia, taxa, bateria, JSON.stringify(f).slice(0, 2000)).run();
  // Guarda só 10 dias de leituras.
  await env.DB.prepare('DELETE FROM leituras WHERE t < ?').bind(Date.now() - 10 * 864e5).run();
  return txt('ok');
}

async function dados(env) {
  await tabela(env);
  const agora = Date.now();
  const { results } = await env.DB.prepare('SELECT estacao, t, total, dia, taxa, bateria FROM leituras WHERE t > ? ORDER BY estacao, t').bind(agora - 4 * 864e5).all();
  const por = {};
  for (const r of results) (por[r.estacao] ||= []).push(r);
  const out = [];
  for (const [estacao, rs] of Object.entries(por)) {
    const ult = rs[rs.length - 1];
    // Chuva numa janela = total agora menos total no início da janela (o aparelho conta sem zerar).
    const janela = h => {
      if (ult.total == null) return null;
      const ini = agora - h * 3600e3;
      const antes = rs.filter(r => r.t <= ini && r.total != null).pop() || rs.find(r => r.total != null);
      if (!antes) return null;
      const v = ult.total - antes.total;
      return v >= 0 ? +v.toFixed(1) : null; // total zerado no aparelho: descarta
    };
    out.push({estacao, ultima: new Date(ult.t).toISOString().slice(0, 19).replace('T', ' '), a1: janela(1), a24: janela(24), a72: janela(72), dia: ult.dia, taxa: ult.taxa, bateria: ult.bateria, leituras24h: rs.filter(r => r.t > agora - 864e5).length});
  }
  return json({at: agora, estacoes: out});
}
