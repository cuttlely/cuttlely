import { acquireTurn, database, releaseTurn, startTurnRenewal } from '../lock.mjs'

const [mode, chatId] = process.argv.slice(2)
const name = 'crash-lease'
if (mode === 'hold') {
    const held = acquireTurn(name, chatId)
    const row = () => database().prepare('SELECT * FROM turns WHERE session_key = ?').get(held.key)
    startTurnRenewal(held)
    const initial = row()
    process.send({ type: 'held', ...initial })
    let reported = false
    setInterval(() => {
        if (!reported && row().expires_at > initial.expires_at) {
            reported = true
            process.send({ type: 'renewed', ...row() })
        }
    }, 10)
} else {
    // A fresh database open, like boot, does not delete another process's turns.
    process.send({ type: 'opened', rows: database().prepare('SELECT * FROM turns').all() })
    process.on('message', () => {
        try {
            const held = acquireTurn(name, chatId)
            releaseTurn(held)
            process.send({ type: 'attempt', acquired: true, at: Date.now() })
        } catch (error) {
            process.send({ type: 'attempt', code: error.code, message: error.message, at: Date.now() })
        }
    })
}
