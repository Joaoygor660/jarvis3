// api/users.js
// Gerencia login e troca de senha obrigatória no primeiro acesso.
// Usa a SERVICE_ROLE_KEY do Supabase no servidor — nunca exposta ao navegador.

module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas." });
  }

  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };

  if (req.method === "GET") {
    const userKey = req.query.userKey;
    if (!userKey) return res.status(400).json({ error: "userKey é obrigatório." });
    const url = `${SUPABASE_URL}/rest/v1/app_users?user_key=eq.${encodeURIComponent(userKey)}&select=custom_password,must_change`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) return res.status(resp.status).json({ error: "Erro ao consultar Supabase." });
    const rows = await resp.json();
    return res.status(200).json(rows[0] || { custom_password: null, must_change: true });
  }

  if (req.method === "POST") {
    const { userKey, newPassword } = req.body || {};
    if (!userKey || !newPassword) return res.status(400).json({ error: "userKey e newPassword são obrigatórios." });
    if (String(newPassword).length < 6) return res.status(400).json({ error: "Senha deve ter ao menos 6 caracteres." });

    const url = `${SUPABASE_URL}/rest/v1/app_users`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_key: userKey,
        custom_password: newPassword,
        must_change: false,
        updated_at: new Date().toISOString()
      })
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return res.status(resp.status).json({ error: "Erro ao salvar senha.", details: errText });
    }
    return res.status(200).json({ ok: true });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método não permitido." });
};
