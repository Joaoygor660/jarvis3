// api/hq.js — Sede Virtual (presença ao vivo + chat da equipe).
// Mesmo padrão seguro do resto do JARVIS: o navegador fala com esta função,
// e só ela fala com o Supabase (service role nunca chega ao front).

module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas." });
  }
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  // GET → estado completo: presença de todos + mensagens (geral + DMs do usuário).
  // "me" identifica quem pergunta: só as DMs DELE voltam (enviadas ou recebidas).
  if (req.method === "GET") {
    try {
      const me = String((req.query && req.query.me) || "").slice(0, 60);
      const filtro = me
        ? `&or=(para.is.null,para.eq.${encodeURIComponent(me)},and(user_key.eq.${encodeURIComponent(me)},para.not.is.null))`
        : `&para=is.null`;
      const [pr, mr] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/app_users?select=user_key,presence_page,presence_at`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/hq_mensagens?select=id,user_key,nome,texto,para,criado_em&order=criado_em.desc&limit=80${filtro}`, { headers })
      ]);
      const presenca = pr.ok ? await pr.json() : [];
      const msgs = mr.ok ? await mr.json() : [];
      return res.status(200).json({ presenca, mensagens: msgs.reverse() });
    } catch (e) {
      return res.status(500).json({ error: "Erro ao consultar estado da base." });
    }
  }

  if (req.method === "POST") {
    const body = req.body || {};

    // Batimento de presença: "estou vivo, nesta guia" (a cada ~2 min e ao navegar)
    if (body.action === "beat") {
      const userKey = String(body.userKey || "").slice(0, 60);
      if (!userKey) return res.status(400).json({ error: "userKey é obrigatório." });
      const page = String(body.page || "").slice(0, 40);
      const r = await fetch(`${SUPABASE_URL}/rest/v1/app_users`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_key: userKey, presence_page: page, presence_at: new Date().toISOString() })
      });
      if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: "Erro no batimento.", details: t.slice(0, 200) }); }
      return res.status(200).json({ ok: true });
    }

    // Mensagem no chat: geral (para=null) ou particular (para=user_key do destinatário)
    if (body.action === "msg") {
      const userKey = String(body.userKey || "").slice(0, 60);
      const nome = String(body.nome || "").slice(0, 80).trim();
      const texto = String(body.texto || "").trim().slice(0, 500);
      const para = body.para ? String(body.para).slice(0, 60) : null;
      if (!userKey || !nome || !texto) return res.status(400).json({ error: "userKey, nome e texto são obrigatórios." });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/hq_mensagens`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({ user_key: userKey, nome, texto, para })
      });
      if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: "Erro ao enviar mensagem.", details: t.slice(0, 200) }); }
      // quem manda mensagem obviamente está online, na sede
      fetch(`${SUPABASE_URL}/rest/v1/app_users`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ user_key: userKey, presence_page: "sede", presence_at: new Date().toISOString() })
      }).catch(() => {});
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: "action inválida (use beat ou msg)." });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método não permitido." });
};
