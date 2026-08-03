// api/hq.js — Sede Virtual (presença ao vivo + chat da equipe).
// Mesmo padrão seguro do resto do JARVIS: o navegador fala com esta função,
// e só ela fala com o Supabase (service role nunca chega ao front).

const _auth = require("./_auth");
module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) {
    return res.status(500).json({ error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas." });
  }
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  // GET → batimento completo do sistema, numa só chamada:
  //   presenca  → quem está online
  //   mensagens → chat geral + canais + DMs de quem perguntou ("me")
  //   v         → versão do deploy (o front detecta publicação nova)
  //   planilha  → data da última planilha enviada (detecta base nova)
  //
  // Os dois últimos moravam num /api/ping separado, mas o plano Hobby da Vercel
  // permite no máximo 12 funções e o ping era o 13º — e era redundante, porque
  // repetia exatamente estas mesmas consultas. Foi dobrado aqui.
  if (req.method === "GET") {
    try {
      const me = String((req.query && req.query.me) || "").slice(0, 60);
      // volta: geral (null) + canais de setor (canal_*) + DMs do usuário
      const filtro = me
        ? `&or=(para.is.null,para.like.canal_*,para.eq.${encodeURIComponent(me)},and(user_key.eq.${encodeURIComponent(me)},para.not.is.null))`
        : `&or=(para.is.null,para.like.canal_*)`;
      // Os dois últimos são para os cards da Visão Geral. Vêm de carona neste
      // batimento em vez de virarem chamadas próprias: rh_vagas tem +1200 linhas
      // e baixá-las inteiras a cada carregamento, só para exibir um número,
      // seria desperdício. Aqui volta apenas o essencial.
      const [pr, mr, sr, vr, lr] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/app_users?select=user_key,presence_page,presence_at`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/hq_mensagens?select=id,user_key,nome,texto,para,criado_em&order=criado_em.desc&limit=80${filtro}`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/dashboard_snapshots?select=created_at&order=created_at.desc&limit=1`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/rh_vagas?select=id&status=not.in.(%22PREENCHIDA%22,%22CANCELADA%22)`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/lig_contatos?select=colaborador,data_contato,criado_em&limit=5000`, { headers })
      ]);
      const presenca = pr.ok ? await pr.json() : [];
      const msgs = mr.ok ? await mr.json() : [];
      let planilha = null;
      if (sr.ok) { const snap = await sr.json().catch(() => []); planilha = (snap && snap[0] && snap[0].created_at) || null; }
      let vagasAbertas = null;
      if (vr.ok) { const v = await vr.json().catch(() => null); if (Array.isArray(v)) vagasAbertas = v.length; }
      let ligContatos = [];
      if (lr.ok) { const l = await lr.json().catch(() => []); if (Array.isArray(l)) ligContatos = l; }
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        presenca,
        mensagens: msgs.reverse(),
        v: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "dev",
        planilha,
        vagasAbertas,
        ligContatos
      });
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
