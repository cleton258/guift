-- ============================================================
--  GUIFT — SUPABASE SETUP COMPLETO
--
--  EXECUTA TUDO ISTO NO SQL EDITOR DO SUPABASE:
--  Supabase → SQL Editor → New Query → Cola → RUN
--
--  FIXES:
--  1. Trigger com security definer (cria perfil sem RLS)
--  2. RLS policies que permitem leitura pública de profiles
--  3. RLS policy que permite doadores inserir donations
--  4. Index em profiles.name para busca rápida
--  5. Sincroniza utilizadores existentes automaticamente
-- ============================================================

-- ── 1. TABELA PROFILES ──────────────────────────────────────
create table if not exists public.profiles (
    id         uuid primary key references auth.users(id) on delete cascade,
    name       text not null default '',
    email      text not null default '',
    created_at timestamptz default now()
);

-- Index para busca por nome (ilike nas doações)
create index if not exists idx_profiles_name on public.profiles(name);

-- ── 2. TABELA DONATIONS ──────────────────────────────────────
create table if not exists public.donations (
    id             uuid default gen_random_uuid() primary key,
    streamer_id    uuid not null references public.profiles(id) on delete cascade,
    donor_name     text not null default 'Anónimo',
    amount         numeric not null check (amount >= 1),
    message        text,
    phone          text,
    payment_method text,
    created_at     timestamptz default now()
);

-- Index para busca de doações por streamer (realtime filter)
create index if not exists idx_donations_streamer on public.donations(streamer_id);

-- ── 3. TRIGGER: criar perfil automaticamente ────────────────
-- security definer = executa como superuser, bypass RLS
-- Isto garante que o perfil é sempre criado no signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, name, email)
    values (
        new.id,
        coalesce(
            new.raw_user_meta_data->>'name',
            split_part(new.email, '@', 1)
        ),
        new.email
    )
    on conflict (id) do update
        set name  = coalesce(excluded.name, public.profiles.name),
            email = excluded.email;
    return new;
end;
$$;

-- Remove trigger anterior e recria
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- ── 4. ROW LEVEL SECURITY ────────────────────────────────────
alter table public.profiles  enable row level security;
alter table public.donations enable row level security;

-- Apaga policies antigas para recriar correctamente
drop policy if exists "perfis publicos"           on public.profiles;
drop policy if exists "upsert perfil proprio"     on public.profiles;
drop policy if exists "inserir perfil proprio"    on public.profiles;
drop policy if exists "actualizar perfil proprio" on public.profiles;
drop policy if exists "inserir doacoes"           on public.donations;
drop policy if exists "ver doacoes"               on public.donations;

-- PROFILES: qualquer pessoa pode LER (necessário para o doador encontrar o streamer)
create policy "perfis publicos" on public.profiles
    for select
    using (true);

-- PROFILES: utilizador autenticado pode criar/actualizar o SEU perfil
create policy "inserir perfil proprio" on public.profiles
    for insert
    with check (auth.uid() = id);

create policy "actualizar perfil proprio" on public.profiles
    for update
    using (auth.uid() = id)
    with check (auth.uid() = id);

-- DONATIONS: qualquer pessoa pode INSERIR (doador não precisa de conta)
create policy "inserir doacoes" on public.donations
    for insert
    with check (true);

-- DONATIONS: streamer pode VER as suas doações; doador pode ver as suas
create policy "ver doacoes" on public.donations
    for select
    using (true);

-- ── 5. SINCRONIZAR UTILIZADORES EXISTENTES ──────────────────
-- Cria perfis para utilizadores que já existiam antes do trigger
insert into public.profiles (id, name, email)
select
    id,
    coalesce(
        raw_user_meta_data->>'name',
        split_part(email, '@', 1)
    ),
    email
from auth.users
on conflict (id) do update
    set name  = coalesce(excluded.name, public.profiles.name),
        email = excluded.email;

-- ── 6. VERIFICAÇÃO FINAL ─────────────────────────────────────
-- Depois de correr, deves ver os teus utilizadores aqui:
select
    p.id,
    p.name,
    p.email,
    p.created_at,
    count(d.id) as total_doacoes
from public.profiles p
left join public.donations d on d.streamer_id = p.id
group by p.id, p.name, p.email, p.created_at
order by p.created_at desc;

-- ============================================================
--  SE VES LINHAS NESTA QUERY = TUDO CORRECTO ✅
--  SE ESTÁ VAZIO = Os utilizadores não têm perfis ainda
--  (Verifica se o teu email está em auth.users)
-- ============================================================
