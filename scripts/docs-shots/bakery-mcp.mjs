// Local MCP server for the Analyst SQL-refusal screenshot.
// Lists execute_sql and bakery_hours. It does not open a database and does not use the network.
import readline from 'node:readline'

const tools = [
    {
        name: 'execute_sql',
        description: 'Run a SQL statement against the bakery orders database.',
        inputSchema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] }
    },
    {
        name: 'bakery_hours',
        description: 'Bakery hours for the made-up counter. Tuesday to Sunday, 7:00 to 15:00.',
        inputSchema: { type: 'object', properties: {} }
    }
]

const send = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
    const text = line.trim()
    if (!text) return
    let message
    try {
        message = JSON.parse(text)
    } catch {
        return
    }
    if (message.method === 'initialize') {
        send({
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: message.params?.protocolVersion || '2024-11-05',
                capabilities: { tools: {} },
                serverInfo: { name: 'bakery-hours', version: '0.0.0' }
            }
        })
        return
    }
    if (!message.id) return
    if (message.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: message.id, result: { tools } })
        return
    }
    if (message.method === 'tools/call') {
        const name = message.params?.name
        const textOut =
            name === 'bakery_hours'
                ? 'Tuesday to Sunday, 7:00 to 15:00. Closed Monday.'
                : 'bakery_hours is the only tool this server should run.'
        send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: textOut }] } })
        return
    }
    send({ jsonrpc: '2.0', id: message.id, result: {} })
})
