// api/checklist.js — Checklist Diário da Base Virtual.
// Travas de negócio ficam AQUI (servidor), não na RLS: o frontend fala com o
// banco via service_role, que ignora RLS. Esta é a fronteira de confiança real.
//   GET  ?t=tarefas                 -> todas as tarefas fixas por cargo
//   GET  ?t=diario&data=YYYY-MM-DD  -> registros do dia (self + equipe)
//   GET  ?t=sup70&data=YYYY-MM-DD   -> {completos,total,ok} regra dos 70%
//   POST  {usuario,tarefa_id,concluido}  -> marca/desmarca (só hoje, após 11h BR)

const _auth = require("./_auth");

// Supervisores com login (user_key). Denominador fixo da regra dos 70% = 8.
const SUP_KEYS = ["rafaelandrade", "adrianomacedo", "edneyferraz", "frankpimentel", "carlos", "jeankleber", "paulosergio", "ronaldocimadon"];
const SUP_TOTAL = SUP_KEYS.length;      // 8
const SUP_TAREFAS = 7;                  // tarefas do cargo supervisor
const LIMITE_HORA = 11;                 // só pode marcar a partir das 11h

// Data e hora no fuso de Brasília, calculadas no servidor (Vercel roda em UTC).
function nowBR() {
  const p = {};
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) };
}

module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return res.status(500).json({ error: "Envs do Supabase não configuradas." });

  const rest = `${SUPABASE_URL}/rest/v1`;
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  const q = req.query || {};

  // Quantos supervisores concluíram 100% (7/7) do checklist no dia informado.
  async function contaSupCompletos(data) {
    const inList = SUP_KEYS.map(k => `"${k}"`).join(",");
    const url = `${rest}/jv_checklist_diario?select=usuario&data=eq.${data}&concluido=eq.true&usuario=in.(${inList})`;
    const r = await fetch(url, { headers });
    if (!r.ok) return { completos: 0, total: SUP_TOTAL };
    const rows = await r.json();
    const cont = {};
    rows.forEach(x => { cont[x.usuario] = (cont[x.usuario] || 0) + 1; });
    const completos = Object.values(cont).filter(n => n >= SUP_TAREFAS).length;
    return { completos, total: SUP_TOTAL };
  }

  try {
    if (req.method === "GET") {
      if (q.t === "tarefas") {
        const r = await fetch(`${rest}/jv_checklist_tarefas?select=*&order=cargo.asc,ordem.asc`, { headers });
        if (!r.ok) return res.status(r.status).json({ error: "Erro ao consultar tarefas." });
        return res.status(200).json({ ok: true, rows: await r.json() });
      }
      if (q.t === "sup70") {
        const data = q.data || nowBR().date;
        const { completos, total } = await contaSupCompletos(data);
        return res.status(200).json({ ok: true, completos, total, liberado: completos / total >= 0.7 });
      }
      // padrão: registros do dia (self + equipe)
      const data = q.data || nowBR().date;
      const r = await fetch(`${rest}/jv_checklist_diario?select=*&data=eq.${data}`, { headers });
      if (!r.ok) return res.status(r.status).json({ error: "Erro ao consultar registros." });
      return res.status(200).json({ ok: true, rows: await r.json() });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const usuario = body.usuario, tarefa_id = body.tarefa_id;
      const concluido = body.concluido !== false; // default true
      if (!usuario || !tarefa_id) return res.status(400).json({ error: "usuario e tarefa_id são obrigatórios." });

      const br = nowBR();
      // Trava 1: janela de horário (só a partir das 11h de Brasília).
      if (br.hour < LIMITE_HORA) return res.status(403).json({ error: `O checklist só pode ser marcado a partir das ${LIMITE_HORA}:00.` });

      // Busca a tarefa para saber se é o item especial dos 70%.
      const rt = await fetch(`${rest}/jv_checklist_tarefas?id=eq.${encodeURIComponent(tarefa_id)}&select=especial`, { headers });
      if (!rt.ok) return res.status(400).json({ error: "Tarefa inválida." });
      const trs = await rt.json();
      if (!trs.length) return res.status(404).json({ error: "Tarefa não encontrada." });

      // Trava 2: regra dos 70% no item "Checklist dos supervisores".
      if (concluido && trs[0].especial === "sup70") {
        const { completos, total } = await contaSupCompletos(br.date);
        if (completos / total < 0.7) {
          return res.status(403).json({ error: `Aguardando supervisores (${completos}/${total} concluídos)`, completos, total });
        }
      }

      // Upsert do registro de HOJE (dias anteriores nunca chegam aqui: data é sempre br.date).
      const row = { usuario, tarefa_id, data: br.date, concluido, hora_conclusao: concluido ? new Date().toISOString() : null };
      const up = await fetch(`${rest}/jv_checklist_diario?on_conflict=usuario,tarefa_id,data`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(row)
      });
      if (!up.ok) { const t = await up.text(); return res.status(up.status).json({ error: "Erro ao salvar.", details: t.slice(0, 300) }); }
      return res.status(200).json({ ok: true, rows: await up.json().catch(() => []) });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método não permitido." });
  } catch (e) {
    return res.status(500).json({ error: "Falha inesperada.", details: String(e && e.message || e).slice(0, 200) });
  }
};
