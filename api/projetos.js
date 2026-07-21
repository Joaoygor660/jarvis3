// api/projetos.js — Módulo Projetos (Evolução/Inovação).
// CRUD multi-tabela no mesmo padrão de api/comercial.js:
//   ?t=projetos | tarefas | ideias | log
// Service role fica só aqui no servidor; o navegador nunca vê a chave.

const CFG = {
  projetos: {
    table: "prj_projetos",
    cols: ["codigo","nome","objetivo","descricao","area","cliente","solicitante","responsavel","equipe","tipo","prioridade","complexidade","status","data_prevista","orcamento","roi_esperado","horas_previstas","horas_executadas","checklist","links","atualizado_em","concluido_em"],
    required: ["nome"],
    order: "criado_em"
  },
  tarefas: {
    table: "prj_tarefas",
    cols: ["projeto_id","titulo","descricao","responsavel","prioridade","prazo","status","tempo_estimado","tempo_realizado","concluido_em"],
    required: ["projeto_id","titulo"],
    order: "criado_em"
  },
  ideias: {
    table: "prj_ideias",
    cols: ["titulo","descricao","problema","solucao","beneficios","area","solicitante","impacto","esforco","roi_esperado","custo_estimado","prioridade","status","responsavel_analise","projeto_id"],
    required: ["titulo"],
    order: "criado_em"
  },
  log: {
    table: "prj_log",
    cols: ["projeto_id","tipo","detalhe","autor"],
    required: ["projeto_id","detalhe"],
    order: "criado_em"
  }
};

const _auth = require("./_auth");
module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return res.status(500).json({ error: "Envs do Supabase não configuradas." });

  const tKey = (req.query && req.query.t) || "projetos";
  const cfg = CFG[tKey];
  if (!cfg) return res.status(400).json({ error: "Tabela inválida. Use t=projetos|tarefas|ideias|log." });

  const base = `${SUPABASE_URL}/rest/v1/${cfg.table}`;
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };
  const body = req.body || {};
  const pick = (src) => {
    const row = {};
    cfg.cols.forEach(c => { if (src[c] !== undefined) row[c] = src[c] === "" ? null : src[c]; });
    return row;
  };

  let resp;
  try {
    if (req.method === "GET") {
      const r = await fetch(`${base}?select=*&order=${cfg.order}.desc&limit=2000`, { headers });
      if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: "Erro ao consultar.", details: t.slice(0, 300) }); }
      return res.status(200).json({ ok: true, rows: await r.json() });
    }
    if (req.method === "POST") {
      const row = pick(body);
      for (const k of cfg.required) if (row[k] === undefined || row[k] === null) return res.status(400).json({ error: `Campo obrigatório ausente: ${k}` });
      resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(row) });
    } else if (req.method === "PATCH") {
      const id = body && body.id;
      if (!id) return res.status(400).json({ error: "Campo id é obrigatório." });
      const row = pick(body);
      if (tKey === "projetos") row.atualizado_em = new Date().toISOString();
      resp = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify(row) });
    } else if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || (body && body.id);
      if (!id) return res.status(400).json({ error: "Parâmetro id é obrigatório." });
      resp = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers });
    } else {
      res.setHeader("Allow", "GET, POST, PATCH, DELETE");
      return res.status(405).json({ error: "Método não permitido." });
    }
    if (!resp.ok) { const t = await resp.text(); return res.status(resp.status).json({ error: "Erro na operação.", details: t.slice(0, 300) }); }
    const data = await resp.json().catch(() => []);
    return res.status(200).json({ ok: true, rows: data });
  } catch (e) {
    return res.status(500).json({ error: "Falha inesperada.", details: String(e && e.message || e).slice(0, 200) });
  }
};
