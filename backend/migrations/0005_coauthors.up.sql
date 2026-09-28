-- SkyFraze: соавторы — творческий круг для общего дела.
--
-- Здесь две вещи:
--   1) users.username — ник для поиска людей (@nick), уникальный без учёта регистра;
--   2) coauthor_links — связь «соавторы» между двумя людьми: заявка и согласие,
--      специализации (кто за что отвечает в общем деле: правописание, проработка
--      героя или злодея, технические концепты, магические системы, ландшафты, арт)
--      и два НЕЗАВИСИМЫХ разрешения «видит мои закрытые проекты» — по одному на
--      каждую сторону, чтобы доступ к закрытому давал владелец, а не проситель.
--
-- Файл идемпотентен: раннер применяет его один раз, но повторный прогон на уже
-- обновлённой базе не должен ломаться (IF NOT EXISTS + условия WHERE username IS NULL).

ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;

-- Ники существующим пользователям: локальная часть email, очищенная до допустимых
-- символов; одинаковые разводим цифровым суффиксом, слишком короткие — по id.
UPDATE users u
   SET username = sub.candidate
  FROM (
      SELECT id,
             CASE WHEN rn = 1 THEN base ELSE base || '-' || rn END AS candidate
        FROM (
            SELECT id,
                   CASE
                     WHEN length(cleaned) >= 3 THEN left(cleaned, 28)
                     ELSE 'user-' || left(replace(id::text, '-', ''), 8)
                   END AS base,
                   row_number() OVER (
                     PARTITION BY CASE
                       WHEN length(cleaned) >= 3 THEN left(cleaned, 28)
                       ELSE 'user-' || left(replace(id::text, '-', ''), 8)
                     END
                     ORDER BY created_at, id
                   ) AS rn
              FROM (
                  SELECT id, created_at,
                         lower(regexp_replace(split_part(email, '@', 1), '[^a-zA-Z0-9_.-]', '', 'g')) AS cleaned
                    FROM users
                   WHERE username IS NULL OR username = ''
              ) c
        ) b
  ) sub
 WHERE u.id = sub.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
    ON users (lower(username)) WHERE username IS NOT NULL;

ALTER TABLE users ALTER COLUMN username SET NOT NULL;

-- ---------- соавторы ----------
CREATE TABLE IF NOT EXISTS coauthor_links (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    addressee_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','accepted','declined')),
    -- Сопроводительное сообщение к заявке.
    message                 TEXT NOT NULL DEFAULT '',
    -- Специализации: за что этот человек отвечает в общем деле. Список свободный,
    -- поэтому TEXT[] — каталог подсказок живёт в интерфейсе и расширяется без миграций.
    crafts                  TEXT[] NOT NULL DEFAULT '{}',
    -- Разрешения на чтение закрытых проектов, по одному на каждую сторону:
    -- requester_shares_closed — приглашающий пускает приглашённого в свои закрытые
    -- проекты, addressee_shares_closed — наоборот.
    requester_shares_closed BOOLEAN NOT NULL DEFAULT false,
    addressee_shares_closed BOOLEAN NOT NULL DEFAULT false,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at              TIMESTAMPTZ,
    CHECK (requester_id <> addressee_id)
);

-- Одна связь на пару людей, независимо от того, кто кого позвал: повторная заявка
-- после отказа обновляет ту же строку, а не плодит дубли.
CREATE UNIQUE INDEX IF NOT EXISTS idx_coauthor_links_pair
    ON coauthor_links (LEAST(requester_id, addressee_id), GREATEST(requester_id, addressee_id));

CREATE INDEX IF NOT EXISTS idx_coauthor_links_requester ON coauthor_links (requester_id);
CREATE INDEX IF NOT EXISTS idx_coauthor_links_addressee ON coauthor_links (addressee_id);
