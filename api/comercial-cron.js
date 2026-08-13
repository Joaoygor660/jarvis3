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

// ── Cópia na caixa de saída ────────────────────────────────────────────────
// SMTP só ENTREGA a mensagem; ele não guarda cópia em lugar nenhum. A pasta
// "Itens Enviados" vive no servidor IMAP e quem grava lá é o programa cliente:
// o Outlook, depois de mandar pelo SMTP, faz um segundo passo e copia a
// mensagem para a pasta. São operações distintas.
//
// Sem este passo, a Gabriela não tem registro do que foi dito em nome dela, e
// uma resposta do cliente chega na caixa sem nenhum histórico do lado dela.
//
// O nome da pasta muda conforme o servidor ("Sent", "INBOX.Sent", "Itens
// Enviados"), então procura-se primeiro pela marcação padrão \Sent do IMAP e
// só depois por nome conhecido.
async function pastaEnviados(client) {
  const lista = await client.list();
  const porFlag = lista.find(m => (m.specialUse || "") === "\\Sent" || (m.flags && m.flags.has && m.flags.has("\\Sent")));
  if (porFlag) return porFlag.path;
  const nomes = ["Sent", "INBOX.Sent", "Itens Enviados", "INBOX.Itens Enviados",
                 "Enviados", "INBOX.Enviados", "Sent Items", "INBOX.Sent Items"];
  for (const n of nomes) {
    const m = lista.find(x => x.path.toLowerCase() === n.toLowerCase());
    if (m) return m.path;
  }
  return null;
}

// Grava a MESMA mensagem que foi enviada. Falha aqui nunca derruba o envio: o
// e-mail já saiu, e ficar sem cópia é bem menos grave do que registrar como
// falha algo que o cliente recebeu.
async function guardarNaCaixaDeSaida(raw, quando) {
  const { ImapFlow } = require("imapflow");
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || process.env.MAIL_HOST || "email-ssl.com.br",
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
    logger: false
  });
  try {
    await client.connect();
    const pasta = await pastaEnviados(client);
    if (!pasta) return { ok: false, motivo: "pasta de enviados não encontrada" };
    await client.append(pasta, raw, ["\\Seen"], quando || new Date());
    return { ok: true, pasta };
  } catch (e) {
    return { ok: false, motivo: String((e && e.message) || e).slice(0, 200) };
  } finally {
    try { await client.logout(); } catch (e) { /* conexão já caiu: irrelevante */ }
  }
}

async function enviarEmail(tx, para, assunto, html) {
  const opcoes = {
    from: process.env.MAIL_FROM || `"Grupo Serv Camp" <${process.env.MAIL_USER}>`,
    to: para,
    subject: assunto,
    html
  };
  // Compõe uma vez e usa os MESMOS bytes para enviar e para arquivar, senão a
  // cópia teria outro Message-ID e não seria a mesma mensagem.
  const MailComposer = require("nodemailer/lib/mail-composer");
  const raw = await new MailComposer(opcoes).compile().build();

  const info = await tx.sendMail({
    envelope: { from: process.env.MAIL_USER, to: para },
    raw
  });
  const enviou = !!(info && info.accepted && info.accepted.length);
  // Guarda o resultado do arquivamento para quem quiser relatar; o retorno
  // continua booleano porque é isso que o laço de envio espera.
  enviarEmail.ultimoArquivo = enviou ? await guardarNaCaixaDeSaida(raw) : null;
  return enviou;
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

  // ?arquivar=1 → recupera a caixa de saída.
  //
  // Os e-mails de 11/08 saíram antes de existir a gravação via IMAP, então não
  // há cópia deles na pasta da Gabriela. Aqui as mensagens são RECONSTRUÍDAS a
  // partir do log (destinatário, etapa e horário estão todos registrados) e
  // gravadas com a DATA ORIGINAL, para a caixa dela refletir o que de fato
  // aconteceu naquela manhã — e não uma pilha de mensagens datadas de hoje.
  //
  // Este bloco NÃO envia nada. Não chama mailer() e não abre conexão SMTP:
  // apenas compõe o texto e grava por IMAP. Nenhum cliente recebe nada.
  //
  // A coluna arquivado_em torna a operação repetível: quem já tem cópia é
  // pulado. Duplicar mensagem na caixa de outra pessoa seria pior do que a
  // ausência que estamos consertando.
  if (req.query && (req.query.arquivar === "1" || req.query.arquivar === "true")) {
    const sb2 = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
    const q = `${SUPABASE_URL}/rest/v1/com_cadencia_log`
      + `?select=id,etapa,destinatario,enviado_em,proposta_id,com_propostas(nome,contato)`
      + `&canal=eq.EMAIL&etapa=gt.0&status=eq.enviado&arquivado_em=is.null&order=enviado_em.asc`;
    const rl = await fetch(q, { headers: sb2 });
    if (!rl.ok) return res.status(502).json({ error: "Falha ao ler o log.", details: (await rl.text()).slice(0, 300) });
    const linhas = await rl.json();

    const simular = req.query.dry === "1" || req.query.dry === "true";
    const out = { pendentes: linhas.length, gravadas: 0, falhas: 0, detalhes: [] };
    if (simular) {
      out.modo = "SIMULAÇÃO — nada gravado";
      out.detalhes = linhas.map(l => ({
        para: l.destinatario, etapa: l.etapa,
        cliente: (l.com_propostas && l.com_propostas.nome) || "?",
        data: l.enviado_em
      }));
      return res.status(200).json(out);
    }

    const MailComposer = require("nodemailer/lib/mail-composer");
    for (const l of linhas) {
      const p = l.com_propostas || {};
      // MESMA regra de saudação do envio original, para o texto bater
      const nome = ((p.contato || p.nome || "").trim().split(" ")[0]) || "tudo bem";
      const quando = new Date(l.enviado_em);
      const raw = await new MailComposer({
        from: process.env.MAIL_FROM || `"Grupo Serv Camp" <${process.env.MAIL_USER}>`,
        to: l.destinatario,
        subject: "Acompanhamento da proposta — Grupo Serv Camp",
        html: corpoEmail(l.etapa, nome),
        date: quando
      }).compile().build();

      const r = await guardarNaCaixaDeSaida(raw, quando);
      if (r.ok) {
        out.gravadas++;
        await fetch(`${SUPABASE_URL}/rest/v1/com_cadencia_log?id=eq.${l.id}`, {
          method: "PATCH",
          headers: { ...sb2, Prefer: "return=minimal" },
          body: JSON.stringify({ arquivado_em: new Date().toISOString() })
        });
      } else {
        out.falhas++;
        out.detalhes.push({ para: l.destinatario, etapa: l.etapa, erro: r.motivo });
      }
    }
    out.resumo = `${out.gravadas} cópia(s) gravada(s) na caixa de saída, com a data original. Nenhum e-mail foi enviado.`;
    return res.status(200).json(out);
  }

  // ?teste=1&para=<email>[&etapa=N] → manda UMA mensagem para o endereço
  // informado e encerra. Existe porque não há outro jeito seguro de provar que
  // o SMTP funciona: rodar o cron de verdade dispararia dezenas de e-mails para
  // clientes reais. Aqui nenhuma proposta é lida, alterada ou registrada — o
  // retorno acontece antes de qualquer consulta ao banco.
  if (req.query && (req.query.teste === "1" || req.query.teste === "true")) {
    const para = String((req.query && req.query.para) || "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(para)) {
      return res.status(400).json({ error: 'Informe o destinatário: ?teste=1&para=voce@dominio.com' });
    }
    const etapa = Number(req.query.etapa || 2);
    if (![2, 3, 4, 5].includes(etapa)) {
      return res.status(400).json({ error: "etapa deve ser 2, 3, 4 ou 5." });
    }
    try {
      const t = mailer();
      // Passa pelo MESMO enviarEmail do envio real, para o teste provar também
      // que a cópia chega na caixa de saída — e não só que o SMTP aceitou.
      const enviou = await enviarEmail(t, para,
        `[TESTE] Cadência comercial — mensagem ${etapa}`,
        '<p style="background:#fffbeb;border-left:4px solid #f59e0b;padding:10px 14px;margin:0 0 16px;'
        + 'font-family:sans-serif;color:#92400e"><b>Este é um envio de teste do JARVIS.</b><br>'
        + 'Nenhum cliente recebeu esta mensagem e nenhuma proposta foi alterada.</p>'
        + corpoEmail(etapa, "Fulano de Tal"));
      const arquivo = enviarEmail.ultimoArquivo || { ok: false, motivo: "não tentou" };
      return res.status(200).json({
        ok: enviou,
        modo: "TESTE — 1 e-mail enviado, nenhuma proposta lida ou alterada",
        para, etapa,
        remetente: process.env.MAIL_USER,
        caixaDeSaida: arquivo.ok ? `cópia gravada em "${arquivo.pasta}"` : `NÃO gravou: ${arquivo.motivo}`
      });
    } catch (e) {
      return res.status(502).json({
        ok: false,
        erro: "Falha no envio SMTP.",
        detalhe: String((e && e.message) || e).slice(0, 300),
        dica: "Confira MAIL_USER, MAIL_PASS, MAIL_HOST (padrão email-ssl.com.br) e MAIL_PORT (padrão 465)."
      });
    }
  }

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
