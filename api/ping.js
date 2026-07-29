// api/ping.js — batimento único do sistema (tempo real "quase instantâneo").
//
// Consolida numa só chamada tudo que o navegador precisa saber periodicamente:
//   v         → versão do deploy (muda a cada publicação na Vercel)
//   planilha  → data da última planilha enviada (muda quando sobe base nova)
//   presenca  → quem está online (mesma fonte do /api/hq)
//   mensagens → chat e DMs do usuário (idem)
//
// Antes existiam DOIS polls batendo no /api/hq (12s e 20s) e nada verificava
// versão nem planilha. Este endpoint substitui os dois, então o número de
// chamadas cai em vez de subir.
//
// Nunca lança: se o Supabase falhar, devolve 200 com o que conseguiu. Um erro
// aqui não pode derrubar a tela de quem está trabalhando.

const _auth = require("./_auth");

module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });

  // A Vercel injeta o SHA do commit em cada deploy; localmente cai em "dev".
  const versao = process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_DEPLOYMENT_ID || "dev";
  const out = { v: versao, planilha: null, presenca: [], mensagens: [] };

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  res.setHeader("Cache-Control", "no-store");
  if (!SUPABASE_URL || !KEY) return res.status(200).json(out);

  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  const me = String((req.query && req.query.me) || "").slice(0, 60);
  const filtro = me
    ? `&or=(para.is.null,para.like.canal_*,para.eq.${encodeURIComponent(me)},and(user_key.eq.${encodeURIComponent(me)},para.not.is.null))`
    : `&or=(para.is.null,para.like.canal_*)`;

  try {
    const [sr, pr, mr] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/dashboard_snapshots?select=created_at&order=created_at.desc&limit=1`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/app_users?select=user_key,presence_page,presence_at`, { headers }),
      fetch(`${SUPABASE_URL}/rest/v1/hq_mensagens?select=id,user_key,nome,texto,para,criado_em&order=criado_em.desc&limit=80${filtro}`, { headers })
    ]);
    if (sr.ok) { const s = await sr.json().catch(() => []); out.planilha = (s && s[0] && s[0].created_at) || null; }
    if (pr.ok) out.presenca = await pr.json().catch(() => []);
    if (mr.ok) out.mensagens = (await mr.json().catch(() => [])).reverse();
  } catch (e) { /* silencioso de propósito */ }

  return res.status(200).json(out);
};
