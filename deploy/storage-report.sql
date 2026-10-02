-- Отчёт о хранении проекта: что занимает место на стенде.
--
-- Запуск (на сервере, из каталога проекта):
--   bash deploy/storage-report.sh
-- или вручную:
--   docker compose -f docker-compose.prod.yml exec -T postgres \
--     psql -U skyfraze -d skyfraze -f - < deploy/storage-report.sql
--
-- План по хранению и что с этими числами делать — docs/storage-compression.md.
-- Тот же отчёт (плюс сверка каталога файлов с базой) доступен из админки:
--   GET  /api/admin/storage        — посмотреть
--   POST /api/admin/storage/sweep  — убрать файлы, на которые никто не ссылается

\pset pager off
\set ON_ERROR_STOP on

\echo '=== Размеры таблиц (heap + TOAST + индексы) ==='
SELECT relname AS table,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
       pg_size_pretty(pg_relation_size(c.oid)) AS heap,
       pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS toast_and_indexes
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r'
 ORDER BY pg_total_relation_size(c.oid) DESC;

\echo ''
\echo '=== База целиком и сжатие снапшотов (TOAST) ==='
-- raw — сколько занимал бы текст снапшота без сжатия, stored — сколько занимает на
-- самом деле: разница и есть бесплатная экономия TOAST (в PG15 это lz4/pglz).
SELECT pg_size_pretty(pg_database_size(current_database())) AS database,
       pg_size_pretty(coalesce(sum(octet_length(yjs_state)), 0)::bigint) AS snapshots_raw,
       count(*) AS snapshots,
       pg_size_pretty(coalesce(sum(pg_column_size(yjs_state)), 0)::bigint) AS snapshots_stored
  FROM project_event_state;

\echo ''
\echo '=== Дублирование текста: снапшот против таблицы событий ==='
SELECT (SELECT pg_size_pretty(coalesce(sum(octet_length(yjs_state)), 0)::bigint) FROM project_event_state) AS in_snapshot,
       (SELECT pg_size_pretty(coalesce(sum(length(title) + length(body)), 0)::bigint) FROM events) AS in_events_table;

\echo ''
\echo '=== Проекты-тяжеловесы (топ-20 по снапшоту) ==='
-- Название показываем ТОЛЬКО у опубликованных проектов: у приватных его заменяет
-- владелец. Название приватного проекта — такое же содержимое, как текст главы, а для
-- действия («попросить владельца почистить») хватает владельца и id.
SELECT p.id,
       CASE WHEN p.is_public THEN left(p.title, 40) ELSE '— приватный —' END AS title,
       coalesce(u.email, '') AS owner,
       pg_size_pretty(coalesce(octet_length(s.yjs_state), 0)::bigint) AS snapshot,
       (SELECT count(*) FROM events e WHERE e.project_id = p.id) AS events,
       pg_size_pretty(coalesce((SELECT sum(a.size) FROM assets a WHERE a.project_id = p.id), 0)::bigint) AS assets_size
  FROM projects p
  LEFT JOIN users u ON u.id = p.owner_id
  LEFT JOIN project_event_state s ON s.project_id = p.id
 ORDER BY octet_length(s.yjs_state) DESC NULLS LAST
 LIMIT 20;

\echo ''
\echo '=== Вложения: строки и объём ==='
SELECT count(*) AS assets, pg_size_pretty(coalesce(sum(size), 0)::bigint) AS total_size
  FROM assets;
