// api/comercial.js — CRUD do módulo Comercial (CRM) via PostgREST do Supabase.
// Multi-tabela: /api/comercial?t=propostas (padrão) | ?t=cadencia | ?t=metas
// Mesmo padrão de api/rh.js: SERVICE_ROLE KEY nas envs da Vercel; RLS bloqueia acesso direto.
//
// Msg 1 da cadência (WhatsApp via Evolution API) dispara quando a proposta tem
// data_envio_proposta + telefone e ainda está na etapa 0 — tanto no POST quanto
// no PATCH (caso o envio da proposta seja registrado depois do cadastro).

const TABLES = {
  propostas: {
    table: "com_propostas",
    required: ["nome"],
    fields: ["tipo_cliente","nome","contato","telefone","email","cidade","servico","origem_lead","data_envio_proposta","valor","status","respondido_em","fechado_em","motivo_perda","visitas","ultima_visita","visita_por","cadencia_ativa","cadencia_etapa","observacao","criado_por","prioridade","proxima_acao","proxima_acao_tipo","proxima_acao_data","responsavel"]
  },
  cadencia: {
    table: "com_cadencia_log",
    required: ["proposta_id","etapa","canal","status"],
    fields: ["proposta_id","etapa","canal","destinatario","status","detalhe"]
  },
  metas: {
    table: "com_metas",
    required: ["mes"],
    fields: ["mes","meta_propostas","meta_fechamentos","meta_valor"]
  }
};

const MSG1 = (nome) => `${nome}\n\nPassando para avisar que a proposta solicitada foi encaminhada.\n\nFico à disposição caso surja qualquer dúvida durante a análise ou caso precise de algum esclarecimento adicional.\n\nAssim que possível, peço a gentileza de confirmar o recebimento.\n\nObrigada!\n\nGabriela Alvarenga`;

const _auth = require("./_auth");
module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas nas variáveis de ambiente da Vercel." });
  }

  const tKey = (req.query && req.query.t) || "propostas";

  // GET ?imapdiag=1 → onde foram parar os e-mails enviados.
  //
  // Os 24 de 11/08 estão todos com arquivado_em preenchido: o APPEND no IMAP
  // respondeu sucesso. Mesmo assim não aparecem no Outlook da Gabriela. Só há
  // duas explicações — gravamos numa pasta que o Outlook dela não mostra, ou o
  // Outlook dela não é IMAP (em POP3 a pasta de enviados é local da máquina e
  // nada que o servidor grave aparece). Listar as pastas do servidor decide.
  //
  // Existe aqui, e não só no cron, porque no cron a chave é o CRON_SECRET e o
  // João teria de montar um curl à mão. Aqui vale o login normal do sistema.
  // É só leitura: não envia, não grava, não move nada. A resposta nunca traz a
  // conta nem a senha.
  if (req.method === "GET" && req.query && (req.query.imapdiag === "1" || req.query.imapdiag === "true")) {
    if (!process.env.MAIL_USER || !process.env.MAIL_PASS) {
      return res.status(200).json({ ok: false, motivo: "MAIL_USER/MAIL_PASS não configuradas." });
    }
    let client;
    try {
      const { ImapFlow } = require("imapflow");
      client = new ImapFlow({
        host: process.env.IMAP_HOST || process.env.MAIL_HOST || "email-ssl.com.br",
        port: Number(process.env.IMAP_PORT || 993),
        secure: true,
        auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
        logger: false
      });
      await client.connect();
      const lista = await client.list();
      const pastas = [];
      for (const m of lista) {
        let qtd = "?";
        let ultima = null;
        try { const st = await client.status(m.path, { messages: true }); qtd = st.messages; } catch (e) {}
        if (qtd && qtd !== "?") {
          try {
            const lock = await client.getMailboxLock(m.path);
            try {
              for await (const msg of client.fetch(`${Math.max(1, qtd)}:*`, { envelope: true })) {
                if (msg.envelope && msg.envelope.date) ultima = msg.envelope.date;
              }
            } finally { lock.release(); }
          } catch (e) {}
        }
        pastas.push({ pasta: m.path, especial: m.specialUse || null, assinada: m.subscribed !== false, mensagens: qtd, ultima_mensagem: ultima });
      }
      // Mesma escolha que a cadência faz na hora de gravar o enviado.
      const porFlag = lista.find(m => (m.specialUse || "") === "\\Sent");
      const nomes = ["Sent","INBOX.Sent","Itens Enviados","INBOX.Itens Enviados",
                     "Enviados","INBOX.Enviados","Sent Items","INBOX.Sent Items"];
      let escolhida = porFlag ? porFlag.path : null;
      if (!escolhida) for (const n of nomes) {
        const m = lista.find(x => x.path.toLowerCase() === n.toLowerCase());
        if (m) { escolhida = m.path; break; }
      }
      await client.logout();
      return res.status(200).json({
        ok: true,
        servidor: process.env.IMAP_HOST || process.env.MAIL_HOST || "email-ssl.com.br",
        pasta_onde_gravamos: escolhida,
        pastas
      });
    } catch (e) {
      try { if (client) await client.logout(); } catch (x) {}
      return res.status(200).json({ ok: false, motivo: String((e && e.message) || e).slice(0, 300) });
    }
  }

  // GET ?wa=1 → a instância do WhatsApp do Comercial está conectada?
  //
  // A Evolution não tem sessão própria: ela é um aparelho pareado, como o
  // WhatsApp Web. Quando o celular fica sem rede ou alguém remove o pareamento,
  // a instância cai e o envio da Msg 1 falha — e falha CALADO. Entre 22/07 e
  // 18/08 foram 23 falhas, e 11 propostas nunca receberam a primeira mensagem
  // sem que ninguém percebesse.
  //
  // Fica aqui em vez de virar /api/whatsapp porque o plano Hobby da Vercel
  // permite no máximo 12 funções e já estamos nas 12.
  if (req.method === "GET" && req.query && (req.query.wa === "1" || req.query.wa === "true")) {
    const url = process.env.EVOLUTION_URL || "https://evolution-api-cizp.srv1815873.hstgr.cloud";
    const inst = process.env.EVOLUTION_INSTANCE_COM || process.env.EVOLUTION_INSTANCE || "servcamp";
    const apikey = process.env.EVOLUTION_APIKEY_COM || process.env.EVOLUTION_APIKEY;
    if (!apikey) return res.status(200).json({ configurado: false, instancia: inst });
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000); // o painel não pode travar por causa disto
      const r = await fetch(`${url}/instance/connectionState/${encodeURIComponent(inst)}`, {
        headers: { apikey }, signal: ctrl.signal
      });
      clearTimeout(t);
      const j = await r.json().catch(() => null);
      // A Evolution responde { instance: { state: "open" | "close" | "connecting" } }
      const estado = (j && j.instance && j.instance.state) || (j && j.state) || null;
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({
        configurado: true,
        instancia: inst,
        estado,
        conectado: estado === "open"
      });
    } catch (e) {
      // Não saber o estado é diferente de estar desconectado: o painel avisa
      // "não consegui verificar" em vez de acusar queda que talvez não exista.
      return res.status(200).json({ configurado: true, instancia: inst, estado: null, conectado: null,
                                    erro: String((e && e.message) || e).slice(0, 120) });
    }
  }
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
      const PAGE = 1000;
      let all = [];
      let offset = 0;
      const orderCol = tKey === "cadencia" ? "enviado_em" : "criado_em";
      while (true) {
        const r = await fetch(`${base}?select=*&order=${orderCol}.desc&limit=${PAGE}&offset=${offset}`, { headers });
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
    } else if (req.method === "POST") {
      const row = pick(body);
      for (const k of cfg.required) {
        if (row[k] === undefined || row[k] === null) return res.status(400).json({ error: `Campo obrigatório ausente: ${k}` });
      }
      // metas: upsert por mês (registrar/atualizar meta do mês num clique)
      const url = tKey === "metas" ? `${base}?on_conflict=mes` : base;
      const hdrs = tKey === "metas" ? { ...headers, Prefer: "return=representation,resolution=merge-duplicates" } : headers;
      resp = await fetch(url, { method: "POST", headers: hdrs, body: JSON.stringify(row) });
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

  // ── Msg 1 da cadência: WhatsApp imediato SOMENTE no CADASTRO da proposta ─────
  // Antes disparava também em PATCH, então mover o card no kanban (troca de
  // status = PATCH) reenviava a mensagem. Agora só no POST (novo cadastro):
  // precisa de telefone + data_envio_proposta, etapa 0, cadência ativa, cliente
  // não respondeu, status não-final.
  let whatsapp = null;
  let wpErro = null;
  if (req.method === "POST" && tKey === "propostas" && process.env.EVOLUTION_APIKEY) {
    const p = Array.isArray(data) ? data[0] : null;
    const statusFinal = p && ["FECHADO", "PERDIDO", "PAUSADO"].includes(p.status);
    if (p && p.telefone && p.data_envio_proposta && (p.cadencia_etapa || 0) === 0 && p.cadencia_ativa !== false && !p.respondido_em && !statusFinal) {
      const url = process.env.EVOLUTION_URL || "https://evolution-api-cizp.srv1815873.hstgr.cloud";
      // Instância do Comercial: número próprio da comercial (EVOLUTION_INSTANCE_COM).
      // Sem essa env, cai na instância padrão — mantém o comportamento atual.
      const inst = process.env.EVOLUTION_INSTANCE_COM || process.env.EVOLUTION_INSTANCE || "servcamp";
      // Chave PRÓPRIA da instância do Comercial (cada instância Evolution tem a sua).
      // Sem EVOLUTION_APIKEY_COM, cai na global (retrocompatível).
      const apikey = process.env.EVOLUTION_APIKEY_COM || process.env.EVOLUTION_APIKEY;
      let num = String(p.telefone).replace(/\D/g, "");
      if (num && !num.startsWith("55")) num = "55" + num;
      const nome = ((p.contato || p.nome || "").trim().split(" ")[0]) || "tudo bem";
      try {
        const wr = await fetch(`${url}/message/sendText/${inst}`, {
          method: "POST",
          headers: { apikey: apikey, "Content-Type": "application/json" },
          body: JSON.stringify({ number: num, text: MSG1(nome) })
        });
        whatsapp = wr.ok ? "enviado" : "falhou";
        if (!wr.ok) { wpErro = `HTTP ${wr.status} inst=${inst} :: ${(await wr.text().catch(()=>"")).slice(0,300)}`; }
      } catch (e) {
        whatsapp = "falhou";
        wpErro = `EXC inst=${inst} :: ${String(e && e.message || e).slice(0,300)}`;
      }
      // registra no log e, se enviou, avança a etapa para 1 (nunca reenvia)
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/com_cadencia_log`, {
          method: "POST",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify({ proposta_id: p.id, etapa: 1, canal: "WHATSAPP", destinatario: p.telefone, status: whatsapp, detalhe: whatsapp === "falhou" ? "Evolution API não confirmou o envio" : null })
        });
        if (whatsapp === "enviado") {
          await fetch(`${SUPABASE_URL}/rest/v1/com_propostas?id=eq.${p.id}`, {
            method: "PATCH",
            headers: { ...headers, Prefer: "return=minimal" },
            body: JSON.stringify({ cadencia_etapa: 1 })
          });
          if (Array.isArray(data) && data[0]) data[0].cadencia_etapa = 1;
        }
      } catch (e) { /* log não pode derrubar o cadastro */ }
    }
  }

  return res.status(200).json({ ok: true, rows: data, whatsapp: whatsapp, wpErro: wpErro });
};
