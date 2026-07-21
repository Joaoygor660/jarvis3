// api/ligacoes.js — Módulo Ligações / Acompanhamento de contatos preventivos.
// CRUD single-table no padrão do api/auditoria.js. Protegido pelo token das APIs.

const _auth = require("./_auth");

const COLS = ["colaborador", "posto", "supervisor", "telefone", "data_contato", "data_falta", "justificativa", "motivo", "acordo", "canal", "impressao", "criado_por"];

module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return res.status(500).json({ error: "Envs do Supabase não configuradas." });

  const base = `${SUPABASE_URL}/rest/v1/lig_contatos`;
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };
  const body = req.body || {};
  const pick = (src) => {
    const row = {};
    COLS.forEach(c => { if (src[c] !== undefined) row[c] = src[c] === "" ? null : src[c]; });
    return row;
  };

  let resp;
  try {
    if (req.method === "GET") {
      const r = await fetch(`${base}?select=*&order=criado_em.desc&limit=5000`, { headers });
      if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: "Erro ao consultar.", details: t.slice(0, 300) }); }
      return res.status(200).json({ ok: true, rows: await r.json() });
    }
    if (req.method === "POST") {
      const row = pick(body);
      if (!row.colaborador) return res.status(400).json({ error: "Campo obrigatório ausente: colaborador" });
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
