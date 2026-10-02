import { defineConfig, devices } from '@playwright/test'

/**
 * Куда идти сценариям. По умолчанию — свой vite на 5173, который Playwright поднимает
 * сам. `E2E_BASE_URL` + `E2E_NO_SERVER=1` позволяют прогнать те же сценарии против уже
 * работающего стенда (в том числе собранной сборки на другом порту) — тогда свой
 * сервер не поднимается вовсе:
 *
 *   E2E_BASE_URL=http://localhost:5199 E2E_NO_SERVER=1 npx playwright test --project=install
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173'
const startOwnServer = !process.env.E2E_NO_SERVER

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  // Бюджет на сценарий. У Playwright по умолчанию 30 с, и это МЕНЬШЕ, чем бюджеты
  // отдельных проверок внутри сценариев (30–60 с): помощь в ожидании не работала бы,
  // а падение выглядело бы как «Test timeout exceeded» вместо внятной причины. Шестьдесят
  // секунд — с запасом на медленный раннер, но не «повисло навсегда».
  timeout: 60_000,
  reporter: 'list',
  use: {
    baseURL,
    // След падения — всегда, а не только на повторе: повторов у нас нет (`retries: 0`,
    // чтобы не прятать нестабильность), а без следа от упавшего сценария остаётся
    // только снимок разметки. Именно так и вышло с падением помощника в CI: чат-ответ
    // пришёл, а строка дерева не появилась, и чем это было — вопросом без ответа.
    trace: 'retain-on-failure',
  },
  /**
   * Два проекта, а не один, ради ПОРЯДКА. Первым идёт `install` — регистрация первого
   * администратора на пустой базе; все остальные сценарии входят уже созданной учётной
   * записью. Полагаться на алфавит файлов нельзя: `auth.spec.ts` идёт раньше
   * `install.spec.ts`, и раньше сценарий первой регистрации именно из-за этого
   * пропускался. При `workers: 1` проекты выполняются строго в порядке объявления.
   */
  projects: [
    { name: 'install', testMatch: /install\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'chromium',
      testIgnore: /install\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: startOwnServer
    ? {
        command: 'npm run dev',
        url: 'http://localhost:5173',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      }
    : undefined,
})
