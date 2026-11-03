ALTER TABLE project_chat_messages DROP COLUMN IF EXISTS knowledge;
ALTER TABLE ai_messages DROP COLUMN IF EXISTS knowledge;
ALTER TABLE ai_conversations DROP COLUMN IF EXISTS kept;
ALTER TABLE project_ai_settings DROP COLUMN IF EXISTS retention_days;
DROP TABLE IF EXISTS ai_knowledge;
