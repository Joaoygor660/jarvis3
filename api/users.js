// api/users.js
// Gerencia login, autenticação por token e troca de senha obrigatória.
// Usa a SERVICE_ROLE_KEY do Supabase no servidor — nunca exposta ao navegador.

const _auth = require("./_auth");

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
    // Painel de Configuração (admin): lista todos os usuários com campos SEGUROS
    // (nunca a senha) — só quem já tem senha própria, se deve trocar e o último acesso.
    if (req.query.all === "1") {
      const url = `${SUPABASE_URL}/rest/v1/app_users?select=user_key,must_change,last_login,login_count,updated_at,custom_password`;
      const resp = await fetch(url, { headers });
      if (!resp.ok) return res.status(resp.status).json({ error: "Erro ao consultar Supabase." });
      const rows = await resp.json();
      const safe = rows.map(r => ({
        user_key: r.user_key,
        has_custom: !!r.custom_password,      // tem senha própria? (booleano, não a senha)
        must_change: r.must_change !== false,
        last_login: r.last_login || null,
        login_count: r.login_count || 0,
        updated_at: r.updated_at || null
      }));
      return res.status(200).json({ users: safe });
    }
    const userKey = req.query.userKey;
    if (!userKey) return res.status(400).json({ error: "userKey é obrigatório." });
    const url = `${SUPABASE_URL}/rest/v1/app_users?user_key=eq.${encodeURIComponent(userKey)}&select=custom_password,must_change`;
    const resp = await fetch(url, { headers });
    if (!resp.ok) return res.status(resp.status).json({ error: "Erro ao consultar Supabase." });
    const rows = await resp.json();
    return res.status(200).json(rows[0] || { custom_password: null, must_change: true });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    // Autenticação: confere a senha própria (custom_password) e devolve um token
    // assinado. Usuários ainda na senha padrão (sem custom_password) não recebem
    // token aqui — recebem ao definir a senha (fluxo de troca obrigatória).
    if (body.action === "authenticate") {
      const userKey = String(body.userKey || "");
      const password = String(body.password || "");
      if (!userKey || !password) return res.status(400).json({ error: "userKey e password são obrigatórios." });
      let row = null;
      try {
        const g = await fetch(`${SUPABASE_URL}/rest/v1/app_users?user_key=eq.${encodeURIComponent(userKey)}&select=custom_password`, { headers });
        if (g.ok) { const rr = await g.json(); row = rr[0] || null; }
      } catch (e) {}
      const ok = !!(row && row.custom_password && row.custom_password === password);
      const secret = process.env.AUTH_SECRET;
      if (ok && secret) return res.status(200).json({ ok: true, token: _auth.sign(userKey, secret, 12) });
      // sem token: senha padrão ainda (ok:false) ou AUTH_SECRET não configurada (grace)
      return res.status(200).json({ ok: false, token: null, grace: !secret });
    }
    // Registro de último acesso (chamado logo após o login válido).
    if (body.action === "login") {
      const userKey = body.userKey;
      if (!userKey) return res.status(400).json({ error: "userKey é obrigatório." });
      // busca o contador atual para incrementar (upsert preserva a senha existente)
      let count = 0;
      try {
        const g = await fetch(`${SUPABASE_URL}/rest/v1/app_users?user_key=eq.${encodeURIComponent(userKey)}&select=login_count`, { headers });
        if (g.ok) { const rr = await g.json(); count = (rr[0] && rr[0].login_count) || 0; }
      } catch (e) {}
      const resp = await fetch(`${SUPABASE_URL}/rest/v1/app_users`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_key: userKey, last_login: new Date().toISOString(), login_count: count + 1 })
      });
      if (!resp.ok) { const t = await resp.text(); return res.status(resp.status).json({ error: "Erro ao registrar acesso.", details: t }); }
      return res.status(200).json({ ok: true });
    }
    const { userKey, newPassword } = body;
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
    // já devolve um token válido: quem acabou de definir a senha entra autenticado
    const secret = process.env.AUTH_SECRET;
    return res.status(200).json({ ok: true, token: secret ? _auth.sign(userKey, secret, 12) : null });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método não permitido." });
};
