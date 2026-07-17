// api/comercial-cron.js — Motor da cadência comercial (e-mails automáticos).
// Roda 1x/dia via Vercel Cron (vercel.json). Envia as Msgs 2/3/4/5 por e-mail
// (SMTP da Locaweb, conta comercial do Grupo ServCamp) conforme os dias desde
// data_envio_proposta:
//   Msg 2: +2 dias | Msg 3: +5 dias | Msg 4: +10 dias | Msg 5: +20 dias (pausa)
//
// Interrupção automática: respondido_em preenchido, status FECHADO/PERDIDO/PAUSADO
// ou cadencia_ativa=false → nunca envia. Cada etapa sai no máximo 1 vez
// (cadencia_etapa guarda a última enviada; com_cadencia_log audita tudo).
// O n8n marca respondido_em ao detectar resposta do cliente na caixa de entrada.
//
// Envs necessárias:
//   MAIL_USER  — conta que envia (ex.: comercial@gruposervcamp.com.br)
//   MAIL_PASS  — senha da conta de e-mail
//   MAIL_HOST  — opcional (padrão email-ssl.com.br) | MAIL_PORT — opcional (padrão 465)
//   MAIL_FROM  — opcional, nome exibido (padrão "Grupo Serv Camp <MAIL_USER>")
//   CRON_SECRET — a Vercel manda como Bearer automaticamente

const nodemailer = require("nodemailer");

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

// Transporter SMTP (Locaweb). Criado uma vez por invocação e reaproveitado.
function mailer() {
  const port = Number(process.env.MAIL_PORT || 465);
  return nodemailer.createTransport({
    host: process.env.MAIL_HOST || "email-ssl.com.br",
    port,
    secure: port === 465,               // 465 = SSL direto; 587 = STARTTLS
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
  });
}

async function enviarEmail(tx, para, assunto, html) {
  const info = await tx.sendMail({
    from: process.env.MAIL_FROM || `"Grupo Serv Camp" <${process.env.MAIL_USER}>`,
    to: para,
    subject: assunto,
    html
  });
  return !!(info && info.accepted && info.accepted.length);
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
  if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
    return res.status(200).json({ ok: false, motivo: "MAIL_USER/MAIL_PASS não configuradas — cadência de e-mail inativa.", enviadas: 0 });
  }
  // ?dry=1 → simula: mostra quem receberia o quê, sem enviar e sem gravar nada.
  const dry = req.query && (req.query.dry === "1" || req.query.dry === "true");

  const sb = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

  // candidatas: cadência ativa, sem resposta, status não-final, proposta enviada, com e-mail
  const filtro = "cadencia_ativa=is.true&respondido_em=is.null&data_envio_proposta=not.is.null&email=not.is.null&cadencia_etapa=lt.5&status=not.in.(FECHADO,PERDIDO,PAUSADO)";
  const r = await fetch(`${SUPABASE_URL}/rest/v1/com_propostas?select=*&${filtro}`, { headers: sb });
  if (!r.ok) return res.status(502).json({ error: "Falha ao consultar propostas.", details: await r.text() });
  const props = await r.json();

  const hoje = new Date(); hoje.setUTCHours(0, 0, 0, 0);
  const resultado = { candidatas: props.length, enviadas: 0, falhas: 0, detalhes: [] };
  if (dry) resultado.modo = "SIMULAÇÃO — nenhum e-mail enviado, nada gravado";
  let tx = null;

  for (const p of props) {
    const envio = new Date(String(p.data_envio_proposta).slice(0, 10) + "T00:00:00Z");
    const dias = Math.floor((hoje - envio) / 86400000);
    // maior etapa vencida ainda não enviada (evita rajada: envia só a mais atual)
    let due = null;
    for (const e of ETAPAS) if (dias >= e.dias && e.etapa > (p.cadencia_etapa || 0)) due = e;
    if (!due) continue;

    const nome = ((p.contato || p.nome || "").trim().split(" ")[0]) || "tudo bem";
    if (dry) {
      resultado.detalhes.push({ id: p.id, nome: p.nome, email: p.email, etapa: due.etapa, dias, status: "simulado" });
      continue;
    }
    let ok = false, detalhe = null;
    try {
      if (!tx) tx = mailer();
      ok = await enviarEmail(tx, p.email, "Acompanhamento da proposta — Grupo Serv Camp", corpoEmail(due.etapa, nome));
      if (!ok) detalhe = "SMTP não confirmou o envio";
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

  if (tx) tx.close();
  return res.status(200).json({ ok: true, ...resultado });
};
