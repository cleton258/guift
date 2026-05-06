-- ============================================================
--  GUIFT — ACTIVAR REALTIME (necessário para o dashboard)
--  Executa SEPARADAMENTE após o SUPABASE_SETUP.sql
-- ============================================================

-- Activar Realtime na tabela donations
-- Supabase → Database → Replication → Tables
-- OU executa este SQL:

alter publication supabase_realtime add table public.donations;
alter publication supabase_realtime add table public.profiles;

-- Verificar se está activo:
select * from pg_publication_tables where pubname = 'supabase_realtime';
