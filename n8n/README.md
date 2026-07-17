# n8n — Leitor de Respostas do Comercial (JARVIS)

## O que isso faz

Quando um cliente **responde o e-mail** da proposta, o n8n detecta em minutos e marca
`respondido_em` no Supabase. A cadência automática **para imediatamente** — o cliente
nunca mais recebe cobrança depois de responder.

```
📥 Chega e-mail em comercial@gruposervcamp.com.br
   → extrai o endereço do remetente
   → procura proposta aberta com aquele e-mail
   → achou? marca respondido_em + promove PROPOSTA → NEGOCIAÇÃO
   → registra o evento na Timeline 360º do JARVIS
```

Se o remetente não for um cliente da base, o fluxo simplesmente para (é e-mail comum).

## Por que n8n e não a Vercel

A Vercel no plano Hobby executa cron **1× por dia** — não dá para ler a caixa de entrada
de minuto em minuto. O n8n roda na VPS sem esse limite.

Divisão de responsabilidades:

| Tarefa | Onde |
|---|---|
| Enviar Msgs 2/3/4/5 (1×/dia) | Vercel — `api/comercial-cron.js` |
| Ler respostas (contínuo) | **n8n** — este fluxo |
| WhatsApp Msg 1 (imediata) | Vercel — `api/comercial.js` → Evolution API |

## Instalação na VPS

```bash
mkdir -p /opt/n8n && cd /opt/n8n
# suba docker-compose.yml para cá, depois crie o .env:
cat > .env <<'EOF'
N8N_HOST=srv1815873.hstgr.cloud
N8N_USER=admin
N8N_PASSWORD=TROQUE_POR_UMA_SENHA_FORTE
TZ=America/Sao_Paulo
EOF
docker compose up -d
docker compose logs -f n8n     # acompanhar a subida
```

Acesse `http://srv1815873.hstgr.cloud:5678` e crie a conta de dono.

> ⚠️ Libere a porta 5678 no firewall da Hostinger.
> Para produção, o ideal é colocar atrás de HTTPS (Nginx/Traefik + Let's Encrypt).

## Configurar o fluxo

1. No n8n: **Workflows → Import from File** → `fluxo-leitor-respostas.json`

2. **Credencial IMAP** (nó "Nova resposta na caixa") — Credentials → New → IMAP:

   | Campo | Valor |
   |---|---|
   | User | `comercial@gruposervcamp.com.br` |
   | Password | *(a senha do e-mail — você digita, ninguém mais precisa saber)* |
   | Host | `email-ssl.com.br` |
   | Port | `993` |
   | SSL/TLS | ativado |

3. **Substituir nos 3 nós HTTP** (procure e troque):
   - `SEU_PROJETO` → `agahqqlhajwhklurcjlc`
   - `SUA_SERVICE_ROLE_KEY` → a mesma `SUPABASE_SERVICE_ROLE_KEY` que está na Vercel

4. **Ative** o workflow (toggle no canto superior direito).

## Testar

1. Cadastre uma proposta de teste no JARVIS com **o seu e-mail pessoal**
2. Responda/envie um e-mail do seu endereço para `comercial@gruposervcamp.com.br`
3. Em segundos: a proposta deve ficar com ✅ **Respondeu** no JARVIS
4. Abra a **Timeline (📜)** da proposta — o evento deve estar registrado

## Segurança

- A senha do e-mail fica **só** dentro do cofre de credenciais do n8n (criptografada)
- A `service_role` key do Supabase dá acesso total ao banco — trate como senha
- Troque `N8N_PASSWORD` por algo forte; a porta 5678 fica exposta na internet
