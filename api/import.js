// api/import.js — a única porta de entrada de dados do JARVIS.
//
// Aceita a planilha por DOIS caminhos, que terminam no mesmo lugar:
//
//   1) JSON  (Content-Type: application/json)
//      É o upload manual: o navegador lê o Excel, interpreta e manda o
//      DASHBOARD_DATA pronto. Comportamento inalterado desde sempre.
//
//   2) ARQUIVO (Content-Type: ...spreadsheet / octet-stream)
//      É a coleta automática: manda-se o .xlsx cru e QUEM INTERPRETA É AQUI,
//      via api/_parse.js. Existe porque a leitura da planilha morava só no
//      navegador, e isso obrigava uma pessoa a estar com a tela aberta para
//      qualquer dado entrar no sistema. Sem este caminho, automatizar é
//      impossível — não há o que chamar.
//
// O _parse.js é cópia caractere a caractere do parser do index.html, e as duas
// pontas usam xlsx 0.18.5, então os dois caminhos produzem o mesmo resultado
// para o mesmo arquivo.
//
// Envio automático exige o cabeçalho x-ingest-token igual à env INGEST_TOKEN
// (o robô não faz login, então não tem token de sessão).

const _auth = require("./_auth");
const crypto = require("crypto");

// Obter o corpo CRU, em bytes, sem depender de como o ambiente se comporta.
//
// A Vercel já consome o stream para preencher req.body, e o que ela entrega
// varia com o Content-Type: objeto (json), texto, ou Buffer (desconhecido).
// Se o stream já foi consumido, esperar por req.on("data") devolveria vazio —
// e o .xlsx chegaria como zero byte. Por isso aproveitamos req.body quando ele
// existe, e só lemos do stream quando não existe (execução local, por ex.).
function lerCorpo(req) {
  const b = req.body;
  if (Buffer.isBuffer(b)) return Promise.resolve(b);
  if (typeof b === "string") return Promise.resolve(Buffer.from(b, "utf8"));
  if (b && typeof b === "object") return Promise.resolve(Buffer.from(JSON.stringify(b), "utf8"));
  return new Promise((resolve, reject) => {
    const partes = [];
    let total = 0;
    req.on("data", c => {
      total += c.length;
      // A Vercel já corta o corpo bem antes disto; o limite aqui é só para
      // falhar com mensagem clara em vez de estourar a memória.
      if (total > 12 * 1024 * 1024) { reject(new Error("Arquivo grande demais (limite 12 MB).")); return; }
      partes.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(partes)));
    req.on("error", reject);
  });
}

const SB = () => ({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY
});

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método não permitido. Use POST." });
  }

  const { url: SUPABASE_URL, key: SUPABASE_SERVICE_ROLE_KEY } = SB();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: "SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas nas variáveis de ambiente da Vercel."
    });
  }
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json"
  };

  const ctype = String((req.headers && req.headers["content-type"]) || "").toLowerCase();
  const ehArquivo = ctype.indexOf("json") < 0;

  // ── quem pode entrar ──────────────────────────────────────────────────────
  const tokenRobo = String((req.headers && req.headers["x-ingest-token"]) || "");
  const esperado = process.env.INGEST_TOKEN || "";
  let origem = "manual";
  if (ehArquivo) {
    // Envio de arquivo é sempre automático e nunca tem sessão: exige o token
    // dedicado. Comparação em tempo constante para não vazar o segredo pelo
    // tempo de resposta.
    const a = Buffer.from(tokenRobo), b = Buffer.from(esperado);
    const ok = esperado && a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(401).json({ error: "Token de coleta inválido ou ausente." });
    origem = "robo";
  } else {
    const _ga = _auth.requireAuth(req);
    if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });
  }

  // ── obter os dados já interpretados ───────────────────────────────────────
  let bruto;
  try { bruto = await lerCorpo(req); }
  catch (e) { return res.status(413).json({ error: String(e.message || e) }); }

  let data, sourceFilename;
  if (ehArquivo) {
    sourceFilename = String((req.headers && req.headers["x-arquivo"]) || "coleta-automatica.xlsx").slice(0, 200);
    if (!bruto.length) return res.status(400).json({ error: "Arquivo vazio." });
    try {
      const XLSX = require("xlsx");
      const P = require("./_parse");
      data = P.buildDataFromWorkbook(XLSX.read(bruto, { type: "buffer", cellDates: true }));
    } catch (e) {
      return res.status(400).json({ error: "Não consegui ler a planilha.", details: String(e.message || e).slice(0, 300) });
    }
  } else {
    let body;
    try { body = JSON.parse(bruto.toString("utf8")); }
    catch (e) { return res.status(400).json({ error: "Corpo da requisição não é um JSON válido." }); }
    data = body && body.data;
    sourceFilename = (body && body.source_filename) || null;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return res.status(400).json({ error: 'Campo "data" ausente ou inválido. Esperado um objeto (o DASHBOARD_DATA inteiro).' });
    }
  }

  let rowCount = 0;
  for (const key of Object.keys(data)) {
    if (Array.isArray(data[key])) rowCount += data[key].length;
  }

  // ── travas de sanidade ────────────────────────────────────────────────────
  // Automação sem estas travas não entrega dado consistente: entrega dado ruim
  // mais rápido e sem ninguém olhando. Só valem para a coleta automática — o
  // upload manual tem uma pessoa vendo a tela e decidindo.
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(data)).digest("hex");
  if (ehArquivo) {
    if (!Array.isArray(data.ativos) || !data.ativos.length) {
      return res.status(422).json({
        error: "Planilha sem a aba FUNCIONARIOS ATIVOS (ou vazia). Nada foi gravado — a base anterior continua no ar."
      });
    }
    // compara com o último envio: quedas bruscas quase sempre são exportação
    // pela metade, não a empresa encolhendo
    let ant = null;
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_snapshots?select=row_count,fingerprint&order=created_at.desc&limit=1`, { headers });
      if (r.ok) { const j = await r.json(); ant = (j && j[0]) || null; }
    } catch (e) { /* sem referência anterior: segue e grava */ }

    if (ant && ant.fingerprint === fingerprint) {
      // Nada mudou desde a última coleta. Com coleta de hora em hora isso será
      // o caso mais comum: gravar cópias idênticas só engorda a base.
      return res.status(200).json({ ok: true, ignorado: "sem alteração desde a última coleta", row_count: rowCount });
    }
    if (ant && ant.row_count && rowCount < ant.row_count * 0.5 && String(req.headers["x-forcar"] || "") !== "1") {
      return res.status(409).json({
        error: "Planilha suspeita: " + rowCount + " linhas contra " + ant.row_count + " da anterior (queda acima de 50%). " +
               "Nada foi gravado. Se a queda for real, reenvie com o cabeçalho x-forcar: 1."
      });
    }
  }

  let supabaseResp;
  try {
    supabaseResp = await fetch(`${SUPABASE_URL}/rest/v1/dashboard_snapshots`, {
      method: "POST",
      headers: { ...headers, Prefer: "return=representation" },
      body: JSON.stringify({
        source_filename: sourceFilename,
        row_count: rowCount,
        fingerprint: fingerprint,
        origem: origem,
        data: data
      })
    });
  } catch (networkErr) {
    return res.status(502).json({ error: "Falha de rede ao falar com o Supabase.", details: String(networkErr) });
  }

  if (!supabaseResp.ok) {
    const errText = await supabaseResp.text();
    return res.status(supabaseResp.status).json({ error: "Supabase rejeitou o insert.", details: errText });
  }

  const inserted = await supabaseResp.json();

  // ── Série histórica do quadro de pessoal ──────────────────────────────────
  // Guarda só a CONTAGEM do dia numa tabela pequena. O snapshot inteiro é um
  // JSON grande: reconstruir a série a partir dele a cada consulta ficaria caro
  // e mais lento a cada planilha nova. Uma linha por dia resolve para sempre.
  // Falha aqui nunca derruba o upload — o snapshot já está salvo.
  try {
    const dist = (arr, campo, filtro) => {
      const s = new Set();
      (arr || []).forEach(r => {
        if (filtro && !filtro(r)) return;
        const v = String((r && r[campo]) || "").trim().toUpperCase();
        if (v) s.add(v);
      });
      return s.size;
    };
    const turno = t => r => String((r && r.TURNO) || "").trim().toUpperCase() === t;
    const hoje = new Date().toISOString().slice(0, 10);
    await fetch(`${SUPABASE_URL}/rest/v1/hist_efetivo?on_conflict=dia`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        dia: hoje,
        ativos: dist(data.ativos, "NOME"),
        clientes: dist(data.clientes, "NOME"),
        diurno: dist(data.ativos, "NOME", turno("DIURNO")),
        noturno: dist(data.ativos, "NOME", turno("NOTURNO")),
        atualizado_em: new Date().toISOString()
      })
    });
  } catch (e) { /* histórico é acessório: não pode impedir o envio da planilha */ }

  // ── Insumos diários da Saúde do Cliente ───────────────────────────────────
  // A agregação vive numa função do banco, não aqui: se a mesma regra existisse
  // em JavaScript e em SQL, um dia as duas divergiriam e o histórico deixaria
  // de bater com a tela sem ninguém perceber.
  // Como o histórico, falha aqui nunca derruba o envio — o snapshot já está
  // salvo, e a próxima importação refaz o cálculo dos mesmos dias.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/atualizar_hist_cliente`, {
      method: "POST", headers, body: "{}"
    });
  } catch (e) { /* idem */ }

  const row = inserted[0] || null;
  if (row) delete row.data; // não devolve o snapshot inteiro de volta
  return res.status(200).json({ ok: true, origem, row_count: rowCount, row });
};
