// Shared steps for the Build with AI live runs. The OpenAI key is read from OPENAI_API_KEY only to store it as
// a credential; it is never printed.
import fs from 'node:fs'
import { BASE, api, log } from './lib.mjs'

export const MODEL = process.env.BUILDER_MODEL || 'gpt-4.1-mini'
export const CREDENTIAL = process.env.BUILDER_CREDENTIAL || 'OpenAI demo'

export async function ensureCredential() {
    const list = await api('GET', '/credentials')
    const found = list.find((c) => c.name === CREDENTIAL && c.credentialName === 'openAIApi')
    if (found) return found.id
    const key = process.env.OPENAI_API_KEY
    if (!key) throw new Error('OPENAI_API_KEY is not set')
    const created = await api('POST', '/credentials', {
        name: CREDENTIAL,
        credentialName: 'openAIApi',
        plainDataObj: { openAIApiKey: key }
    })
    log(`created credential "${CREDENTIAL}"`)
    return created.id
}

export const buildingModel = (credential) => ({
    name: 'chatOpenAI',
    credential,
    inputs: { FLOWISE_CREDENTIAL_ID: credential, modelName: MODEL, temperature: 0.2 }
})

// What the canvas does on save: a card's own credential moves from its inputs to data.credential.
export const asSaved = (nodes) =>
    nodes.map((node) => {
        const data = { ...node.data, inputs: { ...(node.data.inputs || {}) } }
        if ('FLOWISE_CREDENTIAL_ID' in data.inputs) {
            data.credential = data.inputs.FLOWISE_CREDENTIAL_ID
            delete data.inputs.FLOWISE_CREDENTIAL_ID
        }
        return { ...node, data: { ...data, selected: false } }
    })

export const starterConfig = (questions) =>
    JSON.stringify({ starterPrompts: Object.fromEntries(questions.map((prompt, i) => [String(i), { prompt }])) })

export async function signedInPage(viewport = { width: 1366, height: 820 }) {
    const { chromium } = await import(process.env.E2E_PLAYWRIGHT)
    const login = JSON.parse(fs.readFileSync(process.env.E2E_ADMIN_FILE, 'utf8'))
    const browser = await chromium.launch()
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    await page.goto(`${BASE}/signin`, { waitUntil: 'networkidle' })
    const form = page
        .locator('form')
        .filter({ has: page.locator('input[type=password]') })
        .first()
    await form.locator('input').first().fill(login.email)
    await form.locator('input[type=password]').fill(login.password)
    await form.getByRole('button', { name: /^Sign in( with password)?$/ }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/signin'), { timeout: 20000 })
    return { browser, page }
}

export const fitView = async (page) => {
    await page
        .locator('.react-flow__controls-fitview')
        .click()
        .catch(() => {})
    await page.waitForTimeout(600)
}
