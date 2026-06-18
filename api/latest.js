// Salve este arquivo em:  api/latest.js  (raiz do projeto Vercel)
//
// Retorna a linha mais recente de dashboard_snapshots (a última base importada),
// usando a SERVICE_ROLE KEY do Supabase. O navegador chama este endpoint ao
// abrir o dashboard, para carregar sempre os dados mais atuais.

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método não permitido. Use GET." });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas nas variáveis de ambiente da Vercel."
    });
  }

  const query =
    `${SUPABASE_URL}/rest/v1/dashboard_snapshots` +
    `?select=data,created_at,source_filename,row_count&order=created_at.desc&limit=1`;

  let supabaseResp;
  try {
    supabaseResp = await fetch(query, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
  } catch (networkErr) {
    return res.status(502).json({ error: "Falha de rede ao falar com o Supabase.", details: String(networkErr) });
  }

  if (!supabaseResp.ok) {
    const errText = await supabaseResp.text();
    return res.status(supabaseResp.status).json({ error: "Supabase rejeitou a consulta.", details: errText });
  }

  const rows = await supabaseResp.json();
  if (!rows.length) {
    return res.status(404).json({ error: "Nenhum snapshot encontrado ainda." });
  }

  // Cache curto na CDN da Vercel: útil em picos de acesso, sem atrasar
  // a propagação de uma nova importação por mais de alguns segundos.
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
  return res.status(200).json(rows[0]);
};
