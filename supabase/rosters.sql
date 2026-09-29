-- 근무표 클라우드 저장 (Supabase). Supabase 프로젝트에 이미 적용됨 (마이그레이션 이름: create_rosters).
-- 새 프로젝트에 다시 만들 때는 Supabase 대시보드 → SQL Editor 에 이 파일 내용을 붙여넣고 실행한다.
--
-- 근무표 데이터 한 벌 = 한 줄. code(저장 코드)를 아는 사람만 읽고 쓸 수 있게,
-- 표에 직접 접근은 막고(RLS 켜고 정책 없음) 아래 두 함수로만 드나든다.
-- (Supabase 보안 점검이 "anon 이 SECURITY DEFINER 함수를 부를 수 있음"이라고 알려 주는데, 일부러 그렇게 만든 것.)
create table public.rosters (
  code text primary key check (code ~ '^[A-Za-z0-9]{12,64}$'),
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.rosters enable row level security;
revoke all on public.rosters from anon, authenticated;

-- 저장 코드로 근무표 불러오기. 없으면 null
create or replace function public.load_roster(p_code text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select r.data from public.rosters r where r.code = p_code;
$$;

-- 저장 코드로 근무표 저장(없으면 새로 만들고, 있으면 덮어씀). 저장된 시각을 돌려줌
create or replace function public.save_roster(p_code text, p_data jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  saved_at timestamptz;
begin
  if p_code is null or p_code !~ '^[A-Za-z0-9]{12,64}$' then
    raise exception '저장 코드 형식이 잘못됐습니다.';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception '근무표 데이터가 잘못됐습니다.';
  end if;
  if octet_length(p_data::text) > 1000000 then
    raise exception '근무표 데이터가 너무 큽니다.';
  end if;
  insert into public.rosters (code, data, updated_at)
  values (p_code, p_data, now())
  on conflict (code) do update set data = excluded.data, updated_at = now()
  returning updated_at into saved_at;
  return saved_at;
end;
$$;

revoke all on function public.load_roster(text) from public;
revoke all on function public.save_roster(text, jsonb) from public;
grant execute on function public.load_roster(text) to anon, authenticated;
grant execute on function public.save_roster(text, jsonb) to anon, authenticated;
