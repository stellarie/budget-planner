import express from 'express'
import basicAuth from 'express-basic-auth'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 3000
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data')
const STATE_FILE = join(DATA_DIR, 'state.json')

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })

const readStore = () => {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
const writeStore = (store) => writeFileSync(STATE_FILE, JSON.stringify(store))

app.use(basicAuth({
  users: { [process.env.APP_USER || 'sophie']: process.env.APP_PASS || 'changeme' },
  challenge: true,
  realm: "Sophie's Debt-Zero Plan",
}))

app.use(express.json({ limit: '1mb' }))

app.get('/api/state', (req, res) => {
  const store = readStore()
  const value = store[req.query.key]
  if (value === undefined) return res.status(404).json(null)
  res.json({ value })
})

app.post('/api/state', (req, res) => {
  const { key, value } = req.body
  const store = readStore()
  store[key] = value
  writeStore(store)
  res.json({ ok: true })
})

app.delete('/api/state', (req, res) => {
  const store = readStore()
  delete store[req.query.key]
  writeStore(store)
  res.json({ ok: true })
})

app.use(express.static(join(__dirname, 'dist')))

app.get('*', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => console.log(`running on :${PORT}`))
