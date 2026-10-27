import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Стили не блокируют первую отрисовку (0.80.1).
 *
 * Зачем: заставка загрузки живёт в `index.html` с встроенными стилями, но браузер не рисует
 * НИЧЕГО, пока не получит блокирующий `<link rel="stylesheet">` — на медленной связи это
 * секунды пустого экрана (замер на стенде: заставка в DOM на 66 мс, первая отрисовка на 3060 мс).
 * Переводим стили в `preload` + подмену `rel` по загрузке: заставка видна с первого байта, а
 * оформление приложения приезжает до того, как React успевает смонтировать интерфейс (JS больше
 * CSS — 68 против 17 КБ gzip), поэтому вспышки «без стилей» на практике нет.
 *
 * `onload` и `noscript` — не украшения: без первого стили не применятся никогда, без второго
 * страница останется без оформления при выключенном JavaScript.
 */
function asyncStylesheet(): Plugin {
  return {
    name: 'skyfraze-async-stylesheet',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(
        /<link\s+rel="stylesheet"([^>]*?)\shref="([^"]+)"([^>]*)>/g,
        (_match, before: string, href: string, after: string) =>
          `<link rel="preload" as="style" href="${href}"${before}${after} onload="this.onload=null;this.rel='stylesheet'">` +
          `<noscript><link rel="stylesheet" href="${href}"${before}${after}></noscript>`,
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), asyncStylesheet()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8181',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['node_modules', 'dist', 'tests/e2e/**'],
  },
})
