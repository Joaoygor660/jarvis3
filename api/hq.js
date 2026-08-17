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
  // GET ?mapa=1 → pinos do mapa da Saúde do Cliente.
  //
  // Fica fora do batimento normal de propósito: são ~130 endereços que quase
  // nunca mudam, e mandá-los a cada 15 segundos junto da presença seria puro
  // desperdício. O front busca uma vez, quando o usuário abre o mapa.
  if (req.method === "GET" && req.query && (req.query.mapa === "1" || req.query.mapa === "true")) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/mapa_clientes`, {
        method: "POST", headers, body: JSON.stringify({ dias: 30 })
      });
      if (!r.ok) return res.status(502).json({ error: "Falha ao carregar o mapa." });
      const pinos = await r.json().catch(() => []);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ pinos: Array.isArray(pinos) ? pinos : [] });
    } catch (e) {
      return res.status(500).json({ error: "Erro ao montar o mapa." });
    }
  }

  // GET ?supervisor=1 → desempenho por supervisor.
  // Fora do batimento pela mesma razão do mapa: são ~7 linhas que mudam uma vez
  // por dia, quando a planilha sobe. O front busca ao abrir a guia.
  // GET ?supdet=1&sup=NOME&tipo=faltas|visitas|esquecidos|chegadas
  // → as linhas que formaram o indicador. Existe para o número ser auditável:
  // quem discorda de "84% de cobertura" precisa ver QUAIS faltas ficaram sem
  // cobrir, com nome e data.
  if (req.method === "GET" && req.query && (req.query.supdet === "1" || req.query.supdet === "true")) {
    try {
      const sup = String(req.query.sup || "").slice(0, 80);
      const tipo = String(req.query.tipo || "");
      if (!sup || !["faltas", "visitas", "esquecidos", "chegadas"].includes(tipo)) {
        return res.status(400).json({ error: "Informe sup e tipo válido." });
      }
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/detalhe_supervisor`, {
        method: "POST", headers, body: JSON.stringify({ p_sup: sup, p_tipo: tipo, dias: 30 })
      });
      if (!r.ok) return res.status(502).json({ error: "Falha ao carregar o detalhe." });
      const linhas = await r.json().catch(() => []);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ linhas: Array.isArray(linhas) ? linhas : [] });
    } catch (e) {
      return res.status(500).json({ error: "Erro ao montar o detalhe." });
    }
  }

  if (req.method === "GET" && req.query && (req.query.supervisor === "1" || req.query.supervisor === "true")) {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/desempenho_supervisor`, {
        method: "POST", headers, body: JSON.stringify({ dias: 30 })
      });
      if (!r.ok) return res.status(502).json({ error: "Falha ao carregar o desempenho." });
      const linhas = await r.json().catch(() => []);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ supervisores: Array.isArray(linhas) ? linhas : [] });
    } catch (e) {
      return res.status(500).json({ error: "Erro ao montar o desempenho." });
    }
  }

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
      const [pr, mr, sr, vr, lr, hr, sc, ex] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/app_users?select=user_key,presence_page,presence_at`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/hq_mensagens?select=id,user_key,nome,texto,para,criado_em&order=criado_em.desc&limit=80${filtro}`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/dashboard_snapshots?select=created_at&order=created_at.desc&limit=1`, { headers }),
        fetch(`${SUPABASE_URL}/rest/v1/rh_vagas?select=id&status=not.in.(%22PREENCHIDA%22,%22CANCELADA%22)`, { headers }),
        // duracao_min entra aqui para a Visão Geral poder mostrar o tempo médio
        // de conversa sem precisar abrir a guia Ligações.
        fetch(`${SUPABASE_URL}/rest/v1/lig_contatos?select=colaborador,data_contato,criado_em,duracao_min&limit=5000`, { headers }),
        // série do quadro de pessoal: 1 linha por dia, ~365/ano — leve o bastante
        // para vir junto em vez de virar uma consulta própria
        fetch(`${SUPABASE_URL}/rest/v1/hist_efetivo?select=dia,ativos&order=dia.asc&limit=400`, { headers }),
        // Saúde do Cliente: ~128 linhas já calculadas no banco. Vem de carona
        // aqui porque depende de 81 dias de histórico, e o navegador só tem a
        // planilha atual (~20 dias) — não daria para calcular no front.
        fetch(`${SUPABASE_URL}/rest/v1/rpc/saude_clientes`, {
          method: "POST", headers, body: JSON.stringify({ dias: 30 })
        }),
        // RH e Comercial da Visao Geral: cinco numeros do mes corrente
        fetch(`${SUPABASE_URL}/rest/v1/rpc/vg_extras`, { method: "POST", headers, body: "{}" })
      ]);
      const presenca = pr.ok ? await pr.json() : [];
      const msgs = mr.ok ? await mr.json() : [];
      let planilha = null;
      if (sr.ok) { const snap = await sr.json().catch(() => []); planilha = (snap && snap[0] && snap[0].created_at) || null; }
      let vagasAbertas = null;
      if (vr.ok) { const v = await vr.json().catch(() => null); if (Array.isArray(v)) vagasAbertas = v.length; }
      let ligContatos = [];
      if (lr.ok) { const l = await lr.json().catch(() => []); if (Array.isArray(l)) ligContatos = l; }
      let histEfetivo = [];
      if (hr.ok) { const h = await hr.json().catch(() => []); if (Array.isArray(h)) histEfetivo = h; }
      let saudeClientes = [];
      if (sc.ok) { const c = await sc.json().catch(() => []); if (Array.isArray(c)) saudeClientes = c; }
      let extras = null;
      if (ex.ok) { extras = await ex.json().catch(() => null); }
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        presenca,
        mensagens: msgs.reverse(),
        v: process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "dev",
        planilha,
        vagasAbertas,
        ligContatos,
        histEfetivo,
        saudeClientes,
        extras
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
