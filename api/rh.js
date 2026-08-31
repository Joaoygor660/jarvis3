// api/rh.js — CRUD do módulo RH via PostgREST do Supabase.
// Multi-tabela: /api/rh?t=vagas (padrão) | /api/rh?t=entrevistas
// Mesmo padrão de api/import.js: usa a SERVICE_ROLE KEY das variáveis de
// ambiente da Vercel (nunca exposta ao navegador). RLS nas tabelas bloqueia
// qualquer acesso que não venha por aqui.

const TABLES = {
  // Metas da diretoria. Entram aqui, e nao numa funcao propria, porque o plano
  // Hobby da Vercel permite 12 funcoes e ja estamos exatamente nas 12.
  metas: {
    table: "jv_metas",
    required: ["tipo", "mes", "valor"],
    fields: ["tipo","mes","area","valor","observacao","criado_por"]
  },
  vagas: {
    table: "rh_vagas",
    required: ["numero_vaga", "cargo"],
    fields: ["numero_vaga","cargo","escala","posto","area","motivo_abertura","substituicao_de","criterios","status","preenchida_por","data_abertura","data_fechamento","criado_por","jornada","empresa","turno","sexo","perfil","requisitos","fase","usuario_cadastro","tipo_cliente"]
  },
  entrevistas: {
    table: "rh_entrevistas",
    required: ["candidato"],
    fields: ["data_entrevista","candidato","sexo","telefone","cargo","vaga_numero","etapa","situacao","motivo_reprovacao","observacao","criado_por","cidade","bairro","cep"]
  },
  desligamentos: {
    table: "rh_desligamentos",
    required: ["funcionario"],
    fields: ["data_desligamento","funcionario","re","cargo","area","posto","tipo","motivo","data_admissao","observacao","criado_por","aviso_previo","aviso_tipo","aviso_dias"]
  },
  reservas: {
    table: "rh_reservas",
    required: ["funcionario"],
    fields: ["data_oportunidade","funcionario","re","cargo","area","vaga_numero","posto_oferecido","resultado","motivo_recusa","observacao","criado_por"]
  },
  treinamentos: {
    table: "rh_treinamentos",
    required: ["funcionario"],
    fields: ["data_treinamento","funcionario","re","cargo","area","posto","tipo","qtd_videos","tema","treinador","observacao","criado_por"]
  }
};

const _auth = require("./_auth");
module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas nas variáveis de ambiente da Vercel."
    });
  }

  // ── E-mail de supervisor (jv_supervisores) ──────────────────────────────
  // GET  ?heemail=1                    -> lista {area,email} salvos
  // POST ?heemail=1  {area,email}      -> upsert
  if (req.query && (req.query.heemail === "1" || req.query.heemail === "true")) {
    const h2 = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
    if (req.method === "GET") {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/jv_supervisores?select=area,email`, { headers: h2 });
      if (!r.ok) return res.status(502).json({ error: "Falha ao consultar e-mails." });
      return res.status(200).json({ supervisores: await r.json() });
    }
    if (req.method === "POST") {
      const body = req.body || {};
      const area = String(body.area || "").trim();
      const email = String(body.email || "").trim();
      if (!area || !email) return res.status(400).json({ error: "area e email são obrigatórios." });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/jv_supervisores`, {
        method: "POST",
        headers: { ...h2, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ area, email, atualizado_em: new Date().toISOString() })
      });
      if (!r.ok) { const t = await r.text(); return res.status(r.status).json({ error: "Falha ao salvar e-mail.", details: t.slice(0, 200) }); }
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "Método não permitido." });
  }

  // ── Relatório de hora extra por dia/área (jv_supervisores + snapshot) ───
  // GET  ?herelatorio=1&dia=&area=          -> prévia (não envia nada)
  // POST ?herelatorio=1  {dia,area,email,observacao,salvarEmail}  -> envia
  //
  // As linhas SEMPRE vêm do último snapshot salvo no servidor, nunca do corpo
  // da requisição. Se o front mandasse a lista, um clique em "editar" antes de
  // enviar poderia divergir do que a planilha realmente diz — e ninguém
  // perceberia, porque o e-mail sairia mesmo assim.
  if (req.query && (req.query.herelatorio === "1" || req.query.herelatorio === "true")) {
    const h3 = { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" };
    const dia = String((req.method === "GET" ? req.query.dia : (req.body || {}).dia) || "").slice(0, 10);
    const area = String((req.method === "GET" ? req.query.area : (req.body || {}).area) || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || !area) {
      return res.status(400).json({ error: "Informe dia (AAAA-MM-DD) e area." });
    }

    const sr = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_snapshots?select=data&order=created_at.desc&limit=1`, { headers: h3 });
    if (!sr.ok) return res.status(502).json({ error: "Falha ao consultar a última planilha." });
    const snap = await sr.json();
    const todos = (snap[0] && snap[0].data && snap[0].data.hrextra) || [];

    // Extra Entrada = chegou antes do previsto; Extra Saída = saiu depois.
    // Os dois entram no mesmo relatório — os dois são marcação fora do horário.
    const linhas = todos.filter(r =>
      String(r.DATA || "").slice(0, 10) === dia &&
      String(r.AREA || "").trim() === area &&
      ["EXTRA ENTRADA", "EXTRA SAIDA"].includes(String(r.TIPO || "").toUpperCase())
    );

    // MINUTOS guarda SEGUNDOS (nome histórico do campo, não foi corrigido para
    // não quebrar todo o resto do sistema que já lê por esse nome).
    const fmtDur = seg => {
      seg = Number(seg) || 0;
      const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60);
      return h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${m}min`;
    };
    const itens = linhas.map(r => ({
      nome: r.NOME || "—", cliente: r.CLIENTE || r.LOCAL || "—",
      tipo: String(r.TIPO || "").toUpperCase() === "EXTRA ENTRADA" ? "Entrada" : "Saída",
      motivo: r.MOTIVO || "—", duracao: fmtDur(r.MINUTOS), segundos: Number(r.MINUTOS) || 0
    }));
    const totalSeg = itens.reduce((t, x) => t + x.segundos, 0);

    if (req.method === "GET") {
      // prévia: também devolve o e-mail já salvo, se existir
      const er = await fetch(`${SUPABASE_URL}/rest/v1/jv_supervisores?area=eq.${encodeURIComponent(area)}&select=email`, { headers: h3 });
      const ej = er.ok ? await er.json() : [];
      return res.status(200).json({
        itens, total: fmtDur(totalSeg),
        email_salvo: (ej[0] && ej[0].email) || null
      });
    }

    // POST: envia de verdade.
    // Áreas SEM hora extra também podem gerar e-mail — é um reconhecimento
    // ("hoje não tivemos hora extra"), não só um alerta de problema. Por isso
    // não bloqueia mais quando itens.length é zero; o corpo do e-mail é que
    // muda (mensagem de confirmação em vez de tabela).
    if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
      return res.status(200).json({ ok: false, motivo: "MAIL_USER/MAIL_PASS não configuradas — envio de e-mail inativo." });
    }
    const body = req.body || {};
    const destino = String(body.email || "").trim();
    if (!destino || !destino.includes("@")) return res.status(400).json({ error: "Informe um e-mail válido." });
    const observacao = String(body.observacao || "").trim();
    const diaFmt = dia.split("-").reverse().join("/");
    const semOcorrencia = itens.length === 0;

    const linhasHtml = itens.map(x =>
      `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e9f0">${x.nome}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e5e9f0">${x.tipo}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e5e9f0">${x.cliente}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e5e9f0">${x.motivo}</td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #e5e9f0;text-align:right"><b>${x.duracao}</b></td></tr>`
    ).join("");
    const corpoMiolo = semOcorrencia
      ? `<p style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:12px 16px;color:#15803d">
           <b>Não tivemos situação de hora extra</b> (entrada ou saída) registrada em <b>${diaFmt}</b> na área de <b>${area}</b>.
         </p>`
      : `<p>Segue o relatório de <b>hora extra registrada em ${diaFmt}</b> na área de <b>${area}</b>.</p>
         <table style="border-collapse:collapse;width:100%;margin:14px 0">
           <thead><tr style="background:#f1f5f9">
             <th style="padding:6px 10px;text-align:left">Colaborador</th>
             <th style="padding:6px 10px;text-align:left">Tipo</th>
             <th style="padding:6px 10px;text-align:left">Cliente</th>
             <th style="padding:6px 10px;text-align:left">Motivo</th>
             <th style="padding:6px 10px;text-align:right">Duração</th>
           </tr></thead>
           <tbody>${linhasHtml}</tbody>
         </table>
         <p>Total do dia: <b>${fmtDur(totalSeg)}</b> em ${itens.length} marcação(ões).</p>`;
    const html = `<div style="font-family:Arial,sans-serif;color:#0d1f35;font-size:14px;max-width:640px">
      <p>Olá,</p>
      ${corpoMiolo}
      ${observacao ? `<p style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px">${observacao}</p>` : ""}
      <p style="color:#64748b;font-size:12px;margin-top:20px">Relatório gerado automaticamente pelo JARVIS — Grupo ServCamp.</p>
    </div>`;

    try {
      const nodemailer = require("nodemailer");
      const port = Number(process.env.MAIL_PORT || 465);
      const tx = nodemailer.createTransport({
        host: process.env.MAIL_HOST || "email-ssl.com.br", port, secure: port === 465,
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
      });
      await tx.sendMail({
        from: process.env.MAIL_FROM || `"Grupo Serv Camp" <${process.env.MAIL_USER}>`,
        to: destino, subject: `Hora extra — ${area} — ${diaFmt}${semOcorrencia ? " (sem ocorrência)" : ""}`, html
      });
    } catch (e) {
      return res.status(200).json({ ok: false, motivo: String((e && e.message) || e).slice(0, 200) });
    }

    if (body.salvarEmail) {
      await fetch(`${SUPABASE_URL}/rest/v1/jv_supervisores`, {
        method: "POST",
        headers: { ...h3, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ area, email: destino, atualizado_em: new Date().toISOString() })
      }).catch(() => {});
    }
    return res.status(200).json({ ok: true, enviados: itens.length, total: fmtDur(totalSeg) });
  }

  const tKey = (req.query && req.query.t) || "vagas";
  const cfg = TABLES[tKey];
  if (!cfg) return res.status(400).json({ error: `Tabela desconhecida: ${tKey}` });

  const base = `${SUPABASE_URL}/rest/v1/${cfg.table}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }

  function pick(src) {
    const out = {};
    for (const k of cfg.fields) if (src && src[k] !== undefined) out[k] = src[k] === "" ? null : src[k];
    return out;
  }

  let resp;
  try {
    if (req.method === "GET") {
      // Pagina em blocos de 1000 (o PostgREST do Supabase limita a resposta a 1000 linhas),
      // concatenando tudo — necessário porque a base de vagas do SAR tem >1000 registros.
      const PAGE = 1000;
      let all = [];
      let offset = 0;
      while (true) {
        const r = await fetch(`${base}?select=*&order=criado_em.desc&limit=${PAGE}&offset=${offset}`, { headers });
        if (!r.ok) { resp = r; break; }
        const chunk = await r.json();
        all = all.concat(chunk);
        if (!Array.isArray(chunk) || chunk.length < PAGE) { resp = null; break; }
        offset += PAGE;
        if (offset > 20000) { resp = null; break; }
      }
      if (resp === null || resp === undefined) {
        return res.status(200).json({ ok: true, rows: all });
      }
      // se resp foi setado, houve erro numa página -> cai no tratamento de erro abaixo
    } else if (req.method === "POST") {
      const row = pick(body);
      for (const k of cfg.required) {
        if (!row[k]) return res.status(400).json({ error: `Campo obrigatório ausente: ${k}` });
      }
      resp = await fetch(base, { method: "POST", headers, body: JSON.stringify(row) });
    } else if (req.method === "PATCH") {
      const id = body && body.id;
      if (!id) return res.status(400).json({ error: "Campo id é obrigatório para atualizar." });
      const row = pick(body);
      row.atualizado_em = new Date().toISOString();
      resp = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify(row) });
    } else if (req.method === "DELETE") {
      const id = (req.query && req.query.id) || (body && body.id);
      if (!id) return res.status(400).json({ error: "Parâmetro id é obrigatório para excluir." });
      resp = await fetch(`${base}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers });
    } else {
      res.setHeader("Allow", "GET, POST, PATCH, DELETE");
      return res.status(405).json({ error: "Método não permitido." });
    }
  } catch (networkErr) {
    return res.status(502).json({ error: "Falha de rede ao falar com o Supabase.", details: String(networkErr) });
  }

  if (!resp.ok) {
    const errText = await resp.text();
    return res.status(resp.status).json({ error: "Supabase rejeitou a operação.", details: errText });
  }

  const data = await resp.json().catch(() => null);

  // WhatsApp automático (Evolution API) ao cadastrar candidato NOVO com telefone.
  // Só em POST de entrevistas, só se houver telefone e a chave estiver configurada.
  // Falha do envio NÃO bloqueia o cadastro (try/catch).
  let whatsapp = null;
  let wpErro = null;
  if (req.method === "POST" && tKey === "entrevistas" && process.env.EVOLUTION_APIKEY) {
    const novo = Array.isArray(data) ? data[0] : null;
    // Só envia para candidato AINDA no processo. Reprovado/Contratado/Desistiu/etc. NÃO recebe.
    if (novo && novo.telefone && novo.situacao === "EM PROCESSO") {
      const url = process.env.EVOLUTION_URL || "https://evolution-api-cizp.srv1815873.hstgr.cloud";
      // Instância do RH: número próprio do RH (EVOLUTION_INSTANCE_RH).
      // Sem essa env, cai na instância padrão — mantém o comportamento atual.
      const inst = process.env.EVOLUTION_INSTANCE_RH || process.env.EVOLUTION_INSTANCE || "servcamp";
      // Chave da instância do RH: cada instância da Evolution tem a SUA própria
      // apikey. Sem EVOLUTION_APIKEY_RH, cai na global (retrocompatível).
      const apikey = process.env.EVOLUTION_APIKEY_RH || process.env.EVOLUTION_APIKEY;
      // normaliza telefone -> 55 + DDD + número
      let num = String(novo.telefone).replace(/\D/g, "");
      if (num && !num.startsWith("55")) num = "55" + num;
      const nome = (novo.candidato || "").split(" ")[0] || "candidato(a)";
      let cargoLabel = novo.cargo || "";
      if (cargoLabel.toUpperCase().trim() === "ASG") cargoLabel = "Auxiliar de Serviços Gerais";
      const vaga = cargoLabel ? ` para a vaga de ${cargoLabel}` : "";
      const texto = `Olá, ${nome}! 👋\n\nVocê agora faz parte do processo seletivo do *Grupo Serv Camp*${vaga}. Em breve, entraremos em contato com os próximos passos.\n\nDeus abençoe! Boa sorte! 🍀`;
      try {
        const wr = await fetch(`${url}/message/sendText/${inst}`, {
          method: "POST",
          headers: { apikey: apikey, "Content-Type": "application/json" },
          body: JSON.stringify({ number: num, text: texto })
        });
        whatsapp = wr.ok ? "enviado" : "falhou";
        if (!wr.ok) {
          // captura o motivo real da Evolution para diagnóstico
          const body = await wr.text().catch(() => "");
          wpErro = `HTTP ${wr.status} inst=${inst} :: ${body.slice(0, 300)}`;
        }
      } catch (e) {
        whatsapp = "falhou";
        wpErro = `EXC inst=${inst} :: ${String(e && e.message || e).slice(0, 300)}`;
      }
    }
  }

  return res.status(200).json({ ok: true, rows: data, whatsapp: whatsapp, wpErro: wpErro });
};
