-- Run in Supabase SQL Editor.

insert into storage.buckets (id, name, public)
values ('campus-photos', 'campus-photos', true)
on conflict (id) do update set public = true;

drop policy if exists "campus_photos_public_read" on storage.objects;
create policy "campus_photos_public_read"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'campus-photos');

drop policy if exists "campus_photos_public_insert" on storage.objects;
create policy "campus_photos_public_insert"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'campus-photos');

create table if not exists public.paths (
  id uuid primary key default gen_random_uuid(),
  scout_name text not null,
  zone text not null,
  coordinates jsonb not null,
  distance_m numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.junction_pins (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null,
  lng double precision not null,
  status text not null default 'open' check (status in ('open', 'claimed', 'done')),
  created_by text not null,
  claimed_by text,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists public.pins (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null,
  lng double precision not null,
  accuracy numeric,
  heading integer,
  category text not null check (category in ('Cadence View', 'Building Entrance', 'Junction / Turn', 'Shortcut')),
  label text,
  image_url text not null,
  scout_name text not null,
  zone text not null,
  created_at timestamptz not null default now()
);

do $$
declare
  t text;
begin
  foreach t in array array['paths', 'junction_pins', 'pins'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

create or replace function public.save_path_with_split(
  p_scout_name text,
  p_zone text,
  p_coordinates jsonb,
  p_distance_m numeric,
  p_split_path_id uuid default null,
  p_split_segment_idx integer default null,
  p_split_coord jsonb default null
) returns uuid
language plpgsql
as $$
declare
  v_new_id uuid;
  v_existing record;
  v_coords jsonb;
  v_seg1 jsonb := '[]'::jsonb;
  v_seg2 jsonb := '[]'::jsonb;
  v_i integer;
  v_len integer;
begin
  if p_split_path_id is not null and p_split_segment_idx is not null and p_split_coord is not null then
    select * into v_existing from public.paths where id = p_split_path_id for update;
    if found then
      v_coords := v_existing.coordinates;
      v_len := jsonb_array_length(v_coords);

      for v_i in 0..least(p_split_segment_idx, v_len - 1) loop
        v_seg1 := v_seg1 || jsonb_build_array(v_coords->v_i);
      end loop;
      if (v_coords->p_split_segment_idx) <> p_split_coord then
        v_seg1 := v_seg1 || jsonb_build_array(p_split_coord);
      end if;

      v_seg2 := v_seg2 || jsonb_build_array(p_split_coord);
      for v_i in (p_split_segment_idx + 1)..(v_len - 1) loop
        if v_i = p_split_segment_idx + 1 and (v_coords->v_i) = p_split_coord then
          continue;
        end if;
        v_seg2 := v_seg2 || jsonb_build_array(v_coords->v_i);
      end loop;

      if jsonb_array_length(v_seg1) >= 2 and jsonb_array_length(v_seg2) >= 2 then
        update public.paths set coordinates = v_seg1 where id = p_split_path_id;
        insert into public.paths (scout_name, zone, coordinates, distance_m)
        values (v_existing.scout_name, v_existing.zone, v_seg2, v_existing.distance_m / 2);
      end if;
    end if;
  end if;

  insert into public.paths (scout_name, zone, coordinates, distance_m)
  values (p_scout_name, p_zone, p_coordinates, p_distance_m)
  returning id into v_new_id;

  return v_new_id;
end;
$$;
