const _auth = require("./_auth");
module.exports = async function handler(req, res) {
  const _ga = _auth.requireAuth(req);
  if (!_ga.ok) return res.status(401).json({ error: "Não autenticado." });
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY não configurada nas variáveis de ambiente da Vercel." });
  }

  const { question, context } = req.body;
  if (!question) {
    return res.status(400).json({ error: "Pergunta não informada." });
  }

  const systemPrompt = `Você é o Jarvis, assistente inteligente do Dashboard Operacional do Grupo ServCamp — uma empresa de terceirização de serviços (portaria, limpeza, facilities).

Responda sempre em português brasileiro, de forma objetiva e profissional.

Você tem acesso aos dados operacionais atuais do dashboard. Use esses dados para responder perguntas sobre faltas, coberturas, funcionários, horas extras, check list, reservas técnicas, postos descobertos, etc.

Dados operacionais atuais:
${context || "Nenhum dado carregado ainda."}

Regras:
- Responda com base nos dados fornecidos
- Se não souber algo, diga que não tem essa informação nos dados carregados
- Use números e percentuais quando relevante
- Seja direto e conciso
- Formate com markdown quando apropriado`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      return res.status(resp.status).json({ error: errData.error?.message || "Erro na API do Claude" });
    }

    const data = await resp.json();
    const text = data.content && data.content.find(b => b.type === "text");
    res.status(200).json({ answer: text ? text.text : "Sem resposta." });
  } catch (err) {
    res.status(502).json({ error: "Falha ao conectar com a API do Claude: " + String(err) });
  }
};
