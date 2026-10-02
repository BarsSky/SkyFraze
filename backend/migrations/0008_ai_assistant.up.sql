-- 0008_ai_assistant — ИИ-помощник: ключи пользователей, беседы и сообщения.
--
-- Зачем в базе, а не в памяти и не в браузере:
--   * ключи провайдеров — доступ и деньги; в браузере они были бы третьей копией, а в
--     памяти пропадали бы при перезапуске. Лежат только шифрованными (AES-256-GCM),
--     см. backend/internal/ai/keys.go;
--   * беседы и сообщения — история работы с моделью: видно, что просили, что модель
--     ответила и какие инструменты выполнила. Это нужно и человеку (продолжить разговор),
--     и разбору («почему создалась не та глава»).
--
-- Беседы личные: чужая беседа не показывается даже владельцу проекта (это личная
-- переписка, а не содержимое проекта).

CREATE TABLE IF NOT EXISTS ai_user_keys (
    user_id        uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider       text        NOT NULL,
    key_ciphertext bytea       NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider)
);

CREATE TABLE IF NOT EXISTS ai_conversations (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title      text        NOT NULL DEFAULT '',
    model      text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_project_user
    ON ai_conversations (project_id, user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ai_messages (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid        NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role            text        NOT NULL,           -- user | assistant | tool
    content         text        NOT NULL DEFAULT '',
    tool_calls      jsonb       NOT NULL DEFAULT '[]'::jsonb,
    tool_results    jsonb       NOT NULL DEFAULT '[]'::jsonb,
    model           text        NOT NULL DEFAULT '',
    tokens_in       integer     NOT NULL DEFAULT 0,
    tokens_out      integer     NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation
    ON ai_messages (conversation_id, created_at);
