// Salve este arquivo em:  api/import.js  (raiz do projeto Vercel)
//
// Recebe o JSON gerado pelo upload do Excel no navegador (DASHBOARD_DATA) e
// grava uma nova linha em dashboard_snapshots no Supabase, usando a
// SERVICE_ROLE KEY (lida de variável de ambiente da Vercel — nunca exposta
// ao navegador). Não depende do pacote @supabase/supabase-js: fala direto
// com a REST API (PostgREST) do Supabase via fetch nativo do Node.

const _auth = require("./_auth");
module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas nas variáveis de ambiente da Vercel."
    });
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      return res.status(400).json({ error: "Corpo da requisição não é um JSON válido." });
    }
  }

  const data = body && body.data;
  const sourceFilename = (body && body.source_filename) || null;

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return res.status(400).json({ error: 'Campo "data" ausente ou inválido. Esperado um objeto (o DASHBOARD_DATA inteiro).' });
  }

  let rowCount = 0;
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) rowCount += data[key].length;
  }

  let supabaseResp;
  try {
    supabaseResp = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_snapshots`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      body: JSON.stringify({
        source_filename: sourceFilename,
        row_count: rowCount,
        data: data
      })
    });
  } catch (networkErr) {
    return res.status(502).json({ error: "Falha de rede ao falar com o Supabase.", details: String(networkErr) });
  }

  if (!supabaseResp.ok) {
    const errText = await supabaseResp.text();
    return res.status(supabaseResp.status).json({ error: "Supabase rejeitou o insert.", details: errText });
  }

  const inserted = await supabaseResp.json();
  return res.status(200).json({ ok: true, row: inserted[0] || null });
};
