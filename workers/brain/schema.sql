-- what beeline remembers about every api it has learned

create table if not exists apis (
  name        text primary key,
  origin      text not null,
  target      text not null,
  spec        text not null,        -- the whole spec, so we can run it later
  learned_at  text not null,
  status      text not null default 'unknown',  -- healthy | drifted | broken
  checked_at  text,
  note        text
);

-- every health check, so drift has a history rather than just a current value
create table if not exists checks (
  id      integer primary key autoincrement,
  api     text not null,
  ts      text not null,
  ok      integer not null,
  status  integer,
  ms      integer,
  drift   text
);

create index if not exists checks_api_ts on checks (api, ts desc);
