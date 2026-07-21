// api/auditoria.js — Módulo Auditoria de Qualidade (vistorias de postos).
// CRUD multi-tabela no padrão do api/comercial.js:  ?t=auditorias | categorias
// Protegido pelo mesmo token das demais APIs (modo graça até AUTH_ENFORCE=1).

const _auth = require("./_auth");

const CFG = {
  auditorias: {
    table: "aud_auditorias",
    cols: ["posto", "supervisor", "cliente", "data", "inicio", "fim", "nao_conformes", "obs", "pendencias_resolvidas", "criado_por"],
    required: ["posto"],
    order: "criado_em"
  },
  categorias: {
    table: "aud_categorias",
    cols: ["pilar", "item", "ordem"],
    required: ["pilar", "item"],
    order: "ordem"
  }
};

module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return res.status(500).json({ error: "Envs do Supabase não configuradas." });

  const tKey = (req.query && req.query.t) || "auditorias";
  const cfg = CFG[tKey];
  if (!cfg) return res.status(400).json({ error: "Tabela inválida. Use t=auditorias|categorias." });

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
      const r = await fetch(`${base}?select=*&order=${cfg.order}.${tKey === "categorias" ? "asc" : "desc"}&limit=5000`, { headers });
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
      resp = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify(pick(body)) });
    } else if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || (body && body.id);
      if (!id) return res.status(400).json({ error: "Parâmetro id é obrigatório." });
      resp = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers });
    } else {
      res.setHeader("Allow", "GET, POST, PATCH, DELETE");
      return res.status(405).json({ error: "Método não permitido." });
    }
    if (!resp.ok) { const t = await resp.text(); return res.status(resp.status).json({ error: "Erro na operação.", details: t.slice(0, 300) }); }
    return res.status(200).json({ ok: true, rows: await resp.json().catch(() => []) });
  } catch (e) {
    return res.status(500).json({ error: "Falha inesperada.", details: String(e && e.message || e).slice(0, 200) });
  }
};
