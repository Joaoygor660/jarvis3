// api/rh.js — CRUD do módulo RH via PostgREST do Supabase.
// Multi-tabela: /api/rh?t=vagas (padrão) | /api/rh?t=entrevistas
// Mesmo padrão de api/import.js: usa a SERVICE_ROLE KEY das variáveis de
// ambiente da Vercel (nunca exposta ao navegador). RLS nas tabelas bloqueia
// qualquer acesso que não venha por aqui.

const TABLES = {
  vagas: {
    table: "rh_vagas",
    required: ["numero_vaga", "cargo"],
    fields: ["numero_vaga","cargo","escala","posto","area","motivo_abertura","substituicao_de","criterios","status","preenchida_por","data_abertura","data_fechamento","criado_por","jornada","empresa","turno","sexo","perfil","requisitos","fase","usuario_cadastro","tipo_cliente"]
  },
  entrevistas: {
    table: "rh_entrevistas",
    required: ["candidato"],
    fields: ["data_entrevista","candidato","sexo","telefone","cargo","vaga_numero","etapa","situacao","motivo_reprovacao","observacao","criado_por"]
  },
  desligamentos: {
    table: "rh_desligamentos",
    required: ["funcionario"],
    fields: ["data_desligamento","funcionario","re","cargo","area","posto","tipo","motivo","data_admissao","observacao","criado_por"]
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

module.exports = async function handler(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas nas variáveis de ambiente da Vercel."
    });
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
  if (req.method === "POST" && tKey === "entrevistas" && process.env.EVOLUTION_APIKEY) {
    const novo = Array.isArray(data) ? data[0] : null;
    if (novo && novo.telefone) {
      const url = process.env.EVOLUTION_URL || "https://evolution-api-cizp.srv1815873.hstgr.cloud";
      const inst = process.env.EVOLUTION_INSTANCE || "servcamp";
      // normaliza telefone -> 55 + DDD + número
      let num = String(novo.telefone).replace(/\D/g, "");
      if (num && !num.startsWith("55")) num = "55" + num;
      const nome = (novo.candidato || "").split(" ")[0] || "candidato(a)";
      const vaga = novo.cargo ? ` para a vaga de ${novo.cargo}` : "";
      const texto = `Olá, ${nome}! 👋\n\nVocê agora faz parte do processo seletivo do *Grupo ServCamp*${vaga}. Em breve entraremos em contato com os próximos passos.\n\nBoa sorte! 🍀`;
      try {
        const wr = await fetch(`${url}/message/sendText/${inst}`, {
          method: "POST",
          headers: { apikey: process.env.EVOLUTION_APIKEY, "Content-Type": "application/json" },
          body: JSON.stringify({ number: num, text: texto })
        });
        whatsapp = wr.ok ? "enviado" : "falhou";
      } catch (e) {
        whatsapp = "falhou";
      }
    }
  }

  return res.status(200).json({ ok: true, rows: data, whatsapp: whatsapp });
};
