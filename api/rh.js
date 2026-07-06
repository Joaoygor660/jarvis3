// api/rh.js — CRUD do módulo RH via PostgREST do Supabase.
// Multi-tabela: /api/rh?t=vagas (padrão) | /api/rh?t=entrevistas
// Mesmo padrão de api/import.js: usa a SERVICE_ROLE KEY das variáveis de
// ambiente da Vercel (nunca exposta ao navegador). RLS nas tabelas bloqueia
// qualquer acesso que não venha por aqui.

const TABLES = {
  vagas: {
    table: "rh_vagas",
    required: ["numero_vaga", "cargo"],
    fields: ["numero_vaga","cargo","escala","posto","area","motivo_abertura","substituicao_de","criterios","status","preenchida_por","data_abertura","data_fechamento","criado_por"]
  },
  entrevistas: {
    table: "rh_entrevistas",
    required: ["candidato"],
    fields: ["data_entrevista","candidato","sexo","telefone","cargo","vaga_numero","etapa","situacao","motivo_reprovacao","observacao","criado_por"]
  }
};

module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas nas variáveis de ambiente da Vercel."
    });
  }

  const tKey = (req.query && req.query.t) || "vagas";
  const cfg = TABLES[tKey];
  if (!cfg) return res.status(400).json({ error: `Tabela desconhecida: ${tKey}` });

  const base = `${SUPABASE_URL}/rest/v1/${cfg.table}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }

  function pick(src) {
    const out = {};
    for (const k of cfg.fields) if (src && src[k] !== undefined) out[k] = src[k] === "" ? null : src[k];
    return out;
  }

  let resp;
  try {
    if (req.method === "GET") {
      resp = await fetch(`${base}?select=*&order=criado_em.desc&limit=1000`, { headers });
    } else if (req.method === "POST") {
      const row = pick(body);
      for (const k of cfg.required) {
        if (!row[k]) return res.status(400).json({ error: `Campo obrigatório ausente: ${k}` });
      }
      resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(row) });
    } else if (req.method === "PATCH") {
      const id = body && body.id;
      if (!id) return res.status(400).json({ error: "Campo id é obrigatório para atualizar." });
      const row = pick(body);
      row.atualizado_em = new Date().toISOString();
      resp = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify(row) });
    } else if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || (body && body.id);
      if (!id) return res.status(400).json({ error: "Parâmetro id é obrigatório para excluir." });
      resp = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers });
    } else {
      res.setHeader("Allow", "GET, POST, PATCH, DELETE");
      return res.status(405).json({ error: "Método não permitido." });
    }
  } catch (networkErr) {
    return res.status(502).json({ error: "Falha de rede ao falar com o Supabase.", details: String(networkErr) });
  }

  if (!resp.ok) {
    const errText = await resp.text();
    return res.status(resp.status).json({ error: "Supabase rejeitou a operação.", details: errText });
  }

  const data = await resp.json().catch(() => null);
  return res.status(200).json({ ok: true, rows: data });
};
