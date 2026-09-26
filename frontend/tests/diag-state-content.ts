// Diag: показывает фактическое содержимое events/state
import { chromium } from 'playwright'

async function main() {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  page.on('console', (m) => console.log(`[${m.type()}]`, m.text()))
  page.on('requestfailed', (r) => console.log('[reqfail]', r.url(), r.failure()?.errorText))

  const tok = await (async () => {
    const r = await fetch('http://localhost:8181/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `content-${Date.now()}@e.com`, password: 'hunter22!', display_name: 'C',
      }),
    })
    const j: any = await r.json()
    return j.tokens.access as string
  })()

  await page.goto('http://localhost:5173/login')
  await page.evaluate((t) => {
    const s = JSON.parse(localStorage.getItem('skyfraze-auth') ?? '{"state":{}}')
    s.state.accessToken = t
    s.state.refreshToken = 'refresh-fake'
    s.state.user = { id: 'x', email: 'x@x', display_name: 'x' }
    localStorage.setItem('skyfraze-auth', JSON.stringify(s))
  }, tok)

  const projId: string = await page.evaluate(async (t) => {
    const r = await fetch('http://localhost:8181/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify({ title: 'content-diag-v2', description: '' }),
    })
    const j: any = await r.json()
    return j.id
  }, tok)

  console.log('projectId=', projId)

  // open timeline; allow time for hydration
  await page.goto(`http://localhost:5173/projects/${projId}`)
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1500)

  // Probe with auth (we use the token from store via window assignment)
  const result = await page.evaluate(async (p) => {
    // try direct localStorage
    const ls = JSON.parse(localStorage.getItem('skyfraze-auth') ?? '{}')
    const tok = ls?.state?.accessToken
    const headers: Record<string, string> = tok
      ? { Authorization: `Bearer ${tok}` }
      : {}
    headers['Accept'] = 'application/octet-stream'
    const r = await fetch(`/api/projects/${p}/events/state`, { headers })
    return { status: r.status, len: (await r.arrayBuffer()).byteLength, hasToken: !!tok, tokenPrefix: tok?.slice(0, 12) }
  }, projId)
  console.log('probe via localStorage token:', JSON.stringify(result))

  // Click + Событие
  await page.getByRole('button', { name: /\+ Событие/ }).click()
  await page.waitForTimeout(2000)

  // Probe doc.events length in client
  const docState = await page.evaluate(() => {
    const w: any = window
    return {
      hasDoc: !!w.__yjsDoc,
      eventsLen: w.__yjsDoc ? w.__yjsDoc.getArray('events').length : '?',
    }
  })
  console.log('in-page doc state:', JSON.stringify(docState))

  const after = await page.evaluate(async (p) => {
    const ls = JSON.parse(localStorage.getItem('skyfraze-auth') ?? '{}')
    const tok = ls?.state?.accessToken
    const r = await fetch(`/api/projects/${p}/events/state`, {
      headers: { Authorization: `Bearer ${tok}`, Accept: 'application/octet-stream' },
    })
    return { status: r.status, len: (await r.arrayBuffer()).byteLength }
  }, projId)
  console.log('after click probe:', JSON.stringify(after))

  await browser.close()
}

main().catch(console.error)
