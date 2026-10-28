-- 0039_project_chat_threads.down.sql — откат ответов и правки сообщений (0.96.0).
ALTER TABLE project_chat_messages DROP COLUMN IF EXISTS reply_to;
ALTER TABLE project_chat_messages DROP COLUMN IF EXISTS edited_at;
