# n8n — Comercial (JARVIS): Maestro único

Importe **`fluxo-comercial-maestro.json`** — um único workflow que faz as duas coisas:

**A) Envia a cadência (todo dia às 9h)**
```
⏰ Schedule → chama o motor de envio na Vercel (SMTP Locaweb) → envia Msgs 2/3/4/5
```

**B) Lê as respostas (contínuo)**
```
📥 Chega e-mail em comercial@gruposervcamp.com.br
   → extrai o remetente → procura a proposta pelo e-mail
   → achou? marca respondido_em + PROPOSTA → NEGOCIAÇÃO
   → registra na Timeline 360º do JARVIS
```
Se o remetente não for cliente da base, o fluxo para (e-mail comum).

## Por que "maestro único" (modelo B)

Envio e leitura vivem **juntos, num só painel**. Se o n8n cair, os dois param juntos —
e isso é proposital: enviar cobrança **sem** conseguir detectar respostas faria clientes
que já responderam receberem cobrança. Melhor pausar tudo do que cobrar quem respondeu.

O n8n **agenda** e **chama** o endpoint da Vercel que já contém toda a lógica testada de
envio (qual mensagem, quando, sem duplicar). Não há lógica de negócio duplicada em nós.

> O arquivo antigo `fluxo-leitor-respostas.json` (só leitura) fica como referência —
> use o **maestro**.

| Tarefa | Onde |
|---|---|
| Agenda + envia Msgs 2/3/4/5 | **n8n** dispara → `api/comercial-cron.js` (Vercel, SMTP) |
| Lê respostas (contínuo) | **n8n** |
| WhatsApp Msg 1 (imediata) | Vercel — `api/comercial.js` → Evolution API |

> A Vercel **não** agenda mais nada (o `vercel.json` foi removido). O endpoint de envio
> continua existindo — quem o dispara agora é o n8n, protegido pelo `CRON_SECRET`.

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

1. No n8n: **Workflows → Import from File** → `fluxo-comercial-maestro.json`

2. **Credencial IMAP** (nó "Nova resposta na caixa") — Credentials → New → IMAP:

   | Campo | Valor |
   |---|---|
   | User | `comercial@gruposervcamp.com.br` |
   | Password | *(a senha do e-mail — você digita, ninguém mais precisa saber)* |
   | Host | `email-ssl.com.br` |
   | Port | `993` |
   | SSL/TLS | ativado |

3. **Substituir nos nós HTTP** (procure e troque):
   - `SEU_PROJETO` → `agahqqlhajwhklurcjlc`
   - `SUA_SERVICE_ROLE_KEY` → a mesma `SUPABASE_SERVICE_ROLE_KEY` que está na Vercel
   - `SEU_CRON_SECRET` (nó "Envia Msgs 2/3/4/5") → a mesma `CRON_SECRET` que está na Vercel

4. Na **Vercel**, configure as envs de envio: `MAIL_USER`, `MAIL_PASS`, `CRON_SECRET`
   (o motor de envio roda lá; o n8n só o dispara).

5. **Ative** o workflow (toggle no canto superior direito). Os dois gatilhos passam a valer.

## Testar

**Envio (cadência):**
1. Cadastre uma proposta com **seu e-mail** e **data de envio de 2 dias atrás**
2. No n8n, abra o nó "Envia Msgs 2/3/4/5" e clique em **Execute step** (ou rode o
   endpoint com `?dry=1` antes: mostra quem receberia sem enviar nada)
3. O e-mail deve chegar na sua caixa; a proposta avança para a etapa 2 no JARVIS

**Leitura (respostas):**
1. Responda/envie um e-mail do seu endereço para `comercial@gruposervcamp.com.br`
2. Em minutos a proposta fica com ✅ **Respondeu** no JARVIS
3. Abra a **Timeline (📜)** da proposta — o evento deve estar registrado

## Segurança

- A senha do e-mail fica **só** dentro do cofre de credenciais do n8n (criptografada)
- A `service_role` key do Supabase dá acesso total ao banco — trate como senha
- Troque `N8N_PASSWORD` por algo forte; a porta 5678 fica exposta na internet
