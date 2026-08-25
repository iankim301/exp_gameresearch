create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.reports (
  id text primary key,
  share_token uuid not null default gen_random_uuid() unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '7 days'),
  game text not null,
  developer text not null default '',
  overall text not null default '혼재',
  stage text not null default '',
  generated_at text not null default '',
  report_data jsonb not null
);

create index if not exists reports_created_at_idx on public.reports (created_at desc);
create index if not exists reports_expires_at_idx on public.reports (expires_at);

alter table public.reports enable row level security;
revoke all on table public.reports from anon, authenticated;
grant select, insert, update, delete on table public.reports to service_role;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'delete_expired_game_reports') then
    perform cron.schedule(
      'delete_expired_game_reports',
      '15 18 * * 5',
      $cron$delete from public.reports where expires_at <= now();$cron$
    );
  end if;
end
$$;

comment on table public.reports is '팀 게임 동향 보고서. 생성 후 7일 동안 보관하며 매주 토요일 03:15 KST에 만료 데이터를 정리한다.';
