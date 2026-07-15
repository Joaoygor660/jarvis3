// api/comercial-cron.js — Motor da cadência comercial (e-mails automáticos).
// Roda 1x/dia via Vercel Cron (vercel.json). Envia as Msgs 2/3/4/5 por e-mail
// (Microsoft Graph, conta ServCamp) conforme os dias desde data_envio_proposta:
//   Msg 2: +2 dias | Msg 3: +5 dias | Msg 4: +10 dias | Msg 5: +20 dias (pausa)
//
// Interrupção automática: respondido_em preenchido, status FECHADO/PERDIDO/PAUSADO
// ou cadencia_ativa=false → nunca envia. Cada etapa sai no máximo 1 vez
// (cadencia_etapa guarda a última enviada; com_cadencia_log audita tudo).
//
// Envs necessárias: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_SENDER
// (conta que envia), CRON_SECRET (a Vercel manda como Bearer automaticamente).

const ETAPAS = [
  { etapa: 2, dias: 2 },
  { etapa: 3, dias: 5 },
  { etapa: 4, dias: 10 },
  { etapa: 5, dias: 20 }
];

function corpoEmail(etapa, nome) {
  const txt = {
    2: `Olá, ${nome}!\n\nTudo bem?\n\nGostaria de saber se vocês já tiveram a oportunidade de analisar a proposta enviada.\n\nCaso faça sentido, podemos agendar uma visita ou uma reunião para apresentar os detalhes e esclarecer qualquer dúvida.\n\nFico à disposição.`,
    3: `Olá, ${nome}!\n\nPassando para reforçar meu contato.\n\nAcredito que uma conversa rápida pode ajudar a esclarecer os pontos da proposta e entender melhor as necessidades da empresa.\n\nCaso tenham disponibilidade, será um prazer agendarmos uma visita no melhor dia e horário para vocês.`,
    4: `Olá, ${nome}!\n\nEspero que esteja tudo bem.\n\nGostaria de verificar se já conseguiram tomar uma decisão em relação à proposta encaminhada.\n\nCaso ainda estejam avaliando internamente, permaneço à disposição para qualquer ajuste ou esclarecimento necessário.`,
    5: `Olá, ${nome}!\n\nComo não obtive retorno até o momento, vou considerar a negociação em pausa.\n\nPermanecemos à disposição sempre que desejarem retomar a conversa ou caso surjam novas necessidades.\n\nSerá um prazer atendê-los.`
  }[etapa];
  const html = txt.split("\n").map(l => l.trim() ? `<p style="margin:0 0 12px">${l}</p>` : "").join("");
  return html + `<p style="margin:18px 0 0;color:#0d1f35"><b>Grupo Serv Camp</b><br><span style="color:#64748b;font-size:13px">Terceirização de Serviços</span></p>`;
}

async function graphToken() {
  const r = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials"
    })
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("Falha ao obter token Graph: " + JSON.stringify(j));
  return j.access_token;
}

async function enviarEmail(token, para, assunto, html) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(process.env.MS_SENDER)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: assunto,
        body: { contentType: "HTML", content: html },
        toRecipients: [{ emailAddress: { address: para } }]
      },
      saveToSentItems: true
    })
  });
  return r.ok || r.status === 202;
}

module.exports = async function handler(req, res) {
  // Autorização: Vercel Cron envia Authorization: Bearer <CRON_SECRET>.
  // ?secret= permite disparo manual para teste.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers && req.headers.authorization;
  const qsec = req.query && req.query.secret;
  if (secret && auth !== `Bearer ${secret}` && qsec !== secret) {
    return res.status(401).json({ error: "Não autorizado." });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return res.status(500).json({ error: "Envs do Supabase ausentes." });
  if (!process.env.MS_TENANT_ID || !process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET || !process.env.MS_SENDER) {
    return res.status(200).json({ ok: false, motivo: "Envs do Microsoft Graph não configuradas — cadência de e-mail inativa.", enviadas: 0 });
  }

  const sb = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  // candidatas: cadência ativa, sem resposta, status não-final, proposta enviada, com e-mail
  const filtro = "cadencia_ativa=is.true&respondido_em=is.null&data_envio_proposta=not.is.null&email=not.is.null&cadencia_etapa=lt.5&status=not.in.(FECHADO,PERDIDO,PAUSADO)";
  const r = await fetch(`${SUPABASE_URL}/rest/v1/com_propostas?select=*&${filtro}`, { headers: sb });
  if (!r.ok) return res.status(502).json({ error: "Falha ao consultar propostas.", details: await r.text() });
  const props = await r.json();

  const hoje = new Date(); hoje.setUTCHours(0, 0, 0, 0);
  const resultado = { candidatas: props.length, enviadas: 0, falhas: 0, detalhes: [] };
  let token = null;

  for (const p of props) {
    const envio = new Date(String(p.data_envio_proposta).slice(0, 10) + "T00:00:00Z");
    const dias = Math.floor((hoje - envio) / 86400000);
    // maior etapa vencida ainda não enviada (evita rajada: envia só a mais atual)
    let due = null;
    for (const e of ETAPAS) if (dias >= e.dias && e.etapa > (p.cadencia_etapa || 0)) due = e;
    if (!due) continue;

    const nome = ((p.contato || p.nome || "").trim().split(" ")[0]) || "tudo bem";
    let ok = false, detalhe = null;
    try {
      if (!token) token = await graphToken();
      ok = await enviarEmail(token, p.email, "Acompanhamento da proposta — Grupo Serv Camp", corpoEmail(due.etapa, nome));
      if (!ok) detalhe = "Graph não confirmou o envio";
    } catch (e) {
      ok = false; detalhe = String(e).slice(0, 300);
    }

    // audita no log; só avança a etapa se enviou (tenta de novo amanhã em caso de falha)
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/com_cadencia_log`, {
        method: "POST", headers: { ...sb, Prefer: "return=minimal" },
        body: JSON.stringify({ proposta_id: p.id, etapa: due.etapa, canal: "EMAIL", destinatario: p.email, status: ok ? "enviado" : "falhou", detalhe })
      });
      if (ok) {
        const upd = { cadencia_etapa: due.etapa, atualizado_em: new Date().toISOString() };
        if (due.etapa === 5) upd.status = "PAUSADO"; // Msg 5: negociação em pausa (regra do comercial)
        await fetch(`${SUPABASE_URL}/rest/v1/com_propostas?id=eq.${p.id}`, {
          method: "PATCH", headers: { ...sb, Prefer: "return=minimal" },
          body: JSON.stringify(upd)
        });
      }
    } catch (e) { /* log não pode derrubar o job */ }

    resultado[ok ? "enviadas" : "falhas"]++;
    resultado.detalhes.push({ id: p.id, nome: p.nome, etapa: due.etapa, dias, status: ok ? "enviado" : "falhou" });
  }

  return res.status(200).json({ ok: true, ...resultado });
};
