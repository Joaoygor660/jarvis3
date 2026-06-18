-- ============================================================================
-- dashboard_snapshots
-- Cole este script no SQL Editor do Supabase (Project > SQL Editor > New query)
-- e clique em "Run". Pode ser executado mais de uma vez sem erro (idempotente).
-- ============================================================================

create table if not exists public.dashboard_snapshots (
  id               bigint generated always as identity primary key,
  created_at       timestamptz not null default now(),
  source_filename  text,
  row_count        integer,
  data             jsonb not null
);

-- Acelera "pegar a importação mais recente" (ORDER BY created_at DESC LIMIT 1)
create index if not exists dashboard_snapshots_created_at_idx
  on public.dashboard_snapshots (created_at desc);

-- Row Level Security fica ATIVADO e SEM POLICIES de propósito.
-- Toda leitura/escrita acontece através das funções serverless da Vercel
-- (api/import.js e api/latest.js), que usam a SERVICE_ROLE KEY — essa chave
-- ignora RLS por definição. Sem nenhuma policy para "anon"/"authenticated",
-- ninguém consegue ler ou escrever nesta tabela direto do navegador, mesmo
-- que descubra a URL do projeto Supabase.
alter table public.dashboard_snapshots enable row level security;
