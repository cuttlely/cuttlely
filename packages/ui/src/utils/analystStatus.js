// What the Postgres (MCP) tool will read, asked from the server's read-only analystMode lookup:
// 'readonly' (a Postgres URL credential or the server's Postgres URL), 'sandbox' (the server's isolated
// analyst storage), 'invalid' (a Postgres URL is set but a run would refuse it), or 'unavailable' (neither is
// set up). Any failure, including an older server without the
// lookup, is 'unknown', and 'unknown' shows nothing. Display only: nothing here is saved or changes a run.
import { useEffect, useState } from 'react'
import axios from 'axios'
import { baseURL } from '@/store/constant'
import { CREDENTIAL_INPUT } from '@/utils/canvasSave'
import { POSTGRES_NODE, wiredPostgres } from '@/utils/nodeDisplayNames'

export const ANALYST_MODES = ['sandbox', 'readonly', 'invalid', 'unavailable']

// The canvas keeps a credential picked in this session in inputs[CREDENTIAL_INPUT] until it saves, and a loaded
// node has it on data.credential.
export function credentialOf(nodeData) {
    const value = nodeData?.inputs?.[CREDENTIAL_INPUT] || nodeData?.credential || ''
    return typeof value === 'string' ? value : ''
}

export function modeFrom(list) {
    const name = Array.isArray(list) ? list[0]?.name : ''
    return ANALYST_MODES.includes(name) ? name : 'unknown'
}

export async function fetchAnalystMode(nodeData, post = axios.post) {
    try {
        const response = await post(
            `${baseURL}/api/v1/node-load-method/${POSTGRES_NODE}`,
            { ...nodeData, loadMethod: 'analystMode', credential: credentialOf(nodeData) },
            { headers: { 'x-request-from': 'internal', 'Content-type': 'application/json' }, withCredentials: true }
        )
        return modeFrom(response?.data)
    } catch {
        return 'unknown'
    }
}

// Without a credential the answer depends only on the server, so one lookup serves every such node.
let serverWide = null
export function serverAnalystMode(nodeData, post) {
    if (!serverWide) {
        serverWide = fetchAnalystMode({ ...nodeData, credential: '' }, post).then((mode) => {
            if (mode === 'unknown') serverWide = null
            return mode
        })
    }
    return serverWide
}

// A connection picked in the panel is written onto the node data in place, which does not redraw other cards.
// The panel calls notifyConnectionPicked so the link notes on the canvas read the node data again.
const pickListeners = new Set()

export function notifyConnectionPicked() {
    for (const listener of [...pickListeners]) listener()
}

export function useConnectionPicks() {
    const [count, setCount] = useState(0)
    useEffect(() => {
        const listener = () => setCount((value) => value + 1)
        pickListeners.add(listener)
        return () => {
            pickListeners.delete(listener)
        }
    }, [])
    return count
}

export function resetAnalystModeCache() {
    serverWide = null
}

// The panel's mode badge. Looks again when the credential changes.
export function useAnalystMode(nodeData, enabled = true) {
    const credential = credentialOf(nodeData)
    const [state, setState] = useState({ mode: 'unknown', loading: false })
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
        if (!enabled || nodeData?.name !== POSTGRES_NODE) return undefined
        let live = true
        setState((current) => ({ ...current, loading: true }))
        const ask = credential ? fetchAnalystMode(nodeData) : serverAnalystMode(nodeData)
        ask.then((mode) => {
            if (live) setState({ mode, loading: false })
        })
        return () => {
            live = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [credential, enabled, nodeData?.name, attempt])
    // Check again asks the server afresh rather than reusing the shared answer.
    const retry = () => {
        resetAnalystModeCache()
        setAttempt((value) => value + 1)
    }
    return { ...state, retry }
}

// True when a specialist reads only Postgres tools with no credential and the server has neither a Postgres
// URL nor analyst storage turned on. Unknown answers leave it false, so no note appears on a guess.
export function useAnalystOff(nodeId, nodes, edges) {
    const wired = wiredPostgres(nodeId, nodes, edges)
    const needsServer = wired.length > 0 && wired.every((node) => !credentialOf(node.data))
    const [off, setOff] = useState(false)
    useEffect(() => {
        if (!needsServer) {
            setOff(false)
            return undefined
        }
        let live = true
        serverAnalystMode(wired[0].data).then((mode) => {
            if (live) setOff(mode === 'unavailable')
        })
        return () => {
            live = false
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [needsServer])
    return needsServer && off
}

export const ANALYST_OFF_NOTE = 'Analyst is turned off on this server.'
export const ANALYST_OFF_HINT =
    'Its Postgres (MCP) tool has no credential, and the server has no Postgres URL or analyst storage. Choose a Postgres URL credential on the tool, or ask an admin to turn on Analyst storage. The saved harness is unchanged.'

// The mode badge text in the panel's Data source group. 'unknown' has none, so nothing shows on a guess.
export const MODE_TEXT = {
    readonly: {
        severity: 'info',
        badge: 'Read-only database.',
        detail: 'Queries read the configured Postgres database and never change it.'
    },
    sandbox: {
        severity: 'info',
        badge: 'Sandbox.',
        detail: 'No database connection is chosen, so the analyst uses its own storage on this server.'
    },
    invalid: {
        severity: 'warning',
        badge: 'Connection not usable.',
        detail: 'The Postgres URL on the chosen connection or on the server is not one queries can use, for example it is not a valid postgres:// URL or it points at the application database. Choose another connection.'
    },
    unavailable: {
        severity: 'warning',
        badge: 'Not connected.',
        detail: 'Choose a database connection below. This server has no default database for it.'
    }
}
