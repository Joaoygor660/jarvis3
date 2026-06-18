# dashboard-supabase — projeto pronto para deploy na Vercel

## Estrutura (não mude os nomes/caminhos)

```
.
├── index.html        ← o dashboard (servido em "/")
├── package.json      ← marca o projeto e fixa Node 18.x
├── api/
│   ├── import.js     ← POST — grava um novo snapshot no Supabase
│   └── latest.js     ← GET  — devolve o snapshot mais recente
└── supabase_schema.sql
```

Por que os 404 aconteciam antes: `dashboard.html` precisa se chamar `index.html` para ser servido em "/", e as funções precisam estar dentro de uma pasta `api/` na raiz (não soltas com nome `api_import.js`). A Vercel detecta `api/*.js` automaticamente como serverless functions — não precisa de `vercel.json`.

## Deploy

1. **Banco**: no Supabase, abra SQL Editor → cole `supabase_schema.sql` → Run.
2. **Variáveis de ambiente** (Vercel → Project → Settings → Environment Variables, marque Production/Preview/Development):
   - `SUPABASE_URL` = URL do seu projeto Supabase
   - `SUPABASE_SERVICE_ROLE_KEY` = a service_role key (Project Settings → API). **Nunca** a `anon`/`public`.
3. **Deploy**: suba esta pasta inteira (git push, ou arraste a pasta toda no painel da Vercel, ou `vercel --prod` via CLI a partir desta pasta). Não suba apenas o `index.html` sozinho — a pasta `api/` precisa ir junto.
4. Depois de configurar as variáveis de ambiente, faça **Redeploy** (variáveis só são lidas em novos deploys).

## Teste rápido depois do deploy

- Abra `https://seu-projeto.vercel.app/api/latest` direto no navegador. Antes de qualquer importação, deve devolver `404 {"error":"Nenhum snapshot encontrado ainda."}` — isso é esperado e confirma que a função está no ar (diferente do 404 genérico da Vercel quando a rota não existe).
- Abra `https://seu-projeto.vercel.app/`, importe um Excel pelo dashboard. O texto de status deve passar a mostrar "· Sincronizado com Supabase".
- Recarregue a página: os dados devem vir do Supabase (mesmo em outro navegador/computador).
