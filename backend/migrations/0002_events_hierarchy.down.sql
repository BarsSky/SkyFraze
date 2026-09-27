-- 0002 rollback: возвращаем events к «одной строке-снапшоту» и убираем иерархию.
-- ВНИМАНИЕ: down теряет структуру дерева (parent_id/depth) и возвращает колонку
-- yjs_state в events, перенося туда текущий снапшот проекта.

ALTER TABLE events ADD COLUMN IF NOT EXISTS yjs_state BYTEA;

UPDATE events e
   SET yjs_state = s.yjs_state
  FROM project_event_state s
 WHERE s.project_id = e.project_id
   AND e.id = (SELECT id FROM events x WHERE x.project_id = e.project_id
                ORDER BY x.position, x.created_at LIMIT 1);

DROP TABLE IF EXISTS project_event_state;

DROP INDEX IF EXISTS idx_events_parent_position;
DROP INDEX IF EXISTS idx_events_project_depth;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_position_nonneg;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_depth_range;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_no_self_parent;
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_parent_id_fkey;

ALTER TABLE events DROP COLUMN IF EXISTS updated_by;
ALTER TABLE events DROP COLUMN IF EXISTS depth;
ALTER TABLE events DROP COLUMN IF EXISTS parent_id;
