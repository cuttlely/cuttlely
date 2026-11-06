import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useSelector } from 'react-redux'
import ReactFlow, { Background, Controls } from 'reactflow'
import 'reactflow/dist/style.css'
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Drawer, MenuItem, TextField, useMediaQuery } from '@mui/material'
import { IconArrowUpRight, IconChartBar, IconLayoutDashboard, IconPlus, IconRefresh, IconShieldCheck } from '@tabler/icons-react'
import PropTypes from 'prop-types'
import client from '@/api/client'
import harnessesApi from '@/api/harnesses'
import { useAuth } from '@/hooks/useAuth'
import './dashflows.css'
import { supremeRiskTemplate } from './supreme'
import AccountReport, { accountIdentity } from './AccountReport'
import Chart from './Charts'

const blank = { title: 'Untitled dashboard', harness: '', intervalSeconds: 0, cards: [] }
const cell = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))
const date = (v) => (v ? new Date(v).toLocaleString() : 'Not refreshed')
const path = (id) => `/dashflows/${encodeURIComponent(id)}`

export function SourceTable({ rows, selectedColumns, onAccount }) {
    const [sort, setSort] = useState(null)
    const orderedRows = rows.map((row, index) => ({ row, index }))
    if (sort)
        orderedRows.sort(
            (a, b) =>
                String(a.row[sort.field] ?? '').localeCompare(String(b.row[sort.field] ?? ''), undefined, { numeric: true }) *
                sort.direction
        )
    const columns = selectedColumns || [...new Set(rows.flatMap(Object.keys))]
    return (
        <div className='df-table-scroll nodrag nowheel'>
            <table>
                <thead>
                    <tr>
                        {columns.map((c) => (
                            <th key={c}>
                                <button
                                    className='df-sort-header'
                                    onClick={() => setSort({ field: c, direction: sort?.field === c ? -sort.direction : 1 })}
                                >
                                    {c.replaceAll('_', ' ')} {sort?.field === c ? (sort.direction === 1 ? '↑' : '↓') : '↕'}
                                </button>
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {orderedRows.map(({ row: r, index: i }) => (
                        <tr key={i}>
                            {columns.map((c) => (
                                <td key={c}>
                                    {onAccount && c === 'account_name' && accountIdentity(r) ? (
                                        <button className='df-account-link' onClick={() => onAccount(r, i)}>
                                            {cell(r[c])} ↗
                                        </button>
                                    ) : (
                                        cell(r[c])
                                    )}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
SourceTable.propTypes = { rows: PropTypes.array.isRequired, selectedColumns: PropTypes.array, onAccount: PropTypes.func }

export function DashboardCard({ data }) {
    const { card, snapshot, inspect, remove, edit } = data
    const rows = snapshot?.rows || []
    return (
        <article className={`df-card df-card-${card.kind}`}>
            <div className='df-card-top'>
                <span>
                    <IconChartBar size={16} /> {card.kind === 'metric' ? 'KEY METRIC' : card.kind === 'bar' ? 'BREAKDOWN' : 'SOURCE TABLE'}
                </span>
                {edit && (
                    <button className='nodrag df-edit' aria-label={`Filters and settings for ${card.title}`} onClick={() => edit(card)}>
                        Filters ↗
                    </button>
                )}
                {remove && (
                    <button className='nodrag df-remove' aria-label={`Remove ${card.title}`} onClick={() => remove(card.id)}>
                        ×
                    </button>
                )}
            </div>
            <h3>{card.title}</h3>
            <p className='df-scope'>{card.scope}</p>
            {snapshot?.source?.selection && (
                <p className='df-selection'>
                    Showing {snapshot.source.selection.shown} of {snapshot.source.selection.total} eligible opportunities
                </p>
            )}
            {!snapshot ? (
                <div className='df-await'>Ready for its first refresh</div>
            ) : rows.length === 0 ? (
                <div className='df-await'>No rows in this scope</div>
            ) : card.kind === 'metric' ? (
                <div className='df-value'>
                    {cell(rows[0][card.valueField])}
                    <small>{card.valueField}</small>
                </div>
            ) : card.kind === 'table' ? (
                <SourceTable rows={rows} selectedColumns={card.columns} onAccount={(_row, i) => inspect(card, snapshot, i)} />
            ) : (
                <Chart card={card} rows={rows} inspect={(index) => inspect(card, snapshot, index)} />
            )}
            <button className='df-evidence nodrag' disabled={!snapshot} onClick={() => inspect(card, snapshot)}>
                <IconShieldCheck size={16} /> {snapshot ? 'Pinned source · inspect evidence' : 'Source not yet checked'}{' '}
                <IconArrowUpRight size={15} />
            </button>
        </article>
    )
}
DashboardCard.propTypes = { data: PropTypes.object.isRequired }
const nodeTypes = { dashboard: DashboardCard }

export default function DashFlows({ published = false }) {
    const { id } = useParams()
    const workspaceId = useSelector((state) => state.auth.user?.activeWorkspaceId)
    const compact = useMediaQuery('(max-width:650px)')
    const navigate = useNavigate()
    const { hasPermission } = useAuth()
    const editable = !published && hasPermission('chatflows:update')
    const [record, setRecord] = useState(null)
    const [definition, setDefinition] = useState(blank)
    const [dashboards, setDashboards] = useState([])
    const [harnesses, setHarnesses] = useState([])
    const [sources, setSources] = useState([])
    const [busy, setBusy] = useState(false)
    const [dirty, setDirty] = useState(false)
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [editor, setEditor] = useState(null)
    const [evidence, setEvidence] = useState(null)
    const [flow, setFlow] = useState(null)
    const [publishDialog, setPublishDialog] = useState(false)
    const adopt = (value) => {
        setRecord(value)
        setDefinition(value.definition)
        setDirty(false)
    }
    const run = async (fn) => {
        setBusy(true)
        setError('')
        setNotice('')
        try {
            await fn()
        } catch (e) {
            setError(e.response?.data?.message || e.message || 'Request failed. Try again.')
        } finally {
            setBusy(false)
        }
    }
    useEffect(() => {
        let active = true
        setRecord(null)
        setDefinition(blank)
        setDirty(false)
        setError('')
        setEvidence(null)
        const load = async () => {
            try {
                if (id) {
                    const { data } = await client.get(`${path(id)}${published ? '/published' : ''}`)
                    if (active) adopt(data)
                }
                if (!published) {
                    const [list, teams] = await Promise.all([client.get('/dashflows'), harnessesApi.listHarnesses()])
                    if (active) {
                        setDashboards(list.data)
                        setHarnesses(teams.data.filter((h) => !h.incomplete && !h.orphaned))
                    }
                }
            } catch (e) {
                if (active) setError(e.response?.data?.message || 'Could not load this dashboard.')
            }
        }
        load()
        return () => {
            active = false
        }
    }, [id, published, workspaceId])
    useEffect(() => {
        let active = true
        setSources([])
        if (definition.harness && editable)
            client
                .get(`/dashflows/sources/${encodeURIComponent(definition.harness)}`)
                .then(({ data }) => {
                    if (active) setSources(data.sources)
                })
                .catch(() => {
                    if (active) setError('Could not load the harness’s tested sources.')
                })
        return () => {
            active = false
        }
    }, [definition.harness, editable])
    const change = (patch) => {
        setDefinition((d) => ({ ...d, ...patch }))
        setDirty(true)
    }
    const remove = (cardId) => change({ cards: definition.cards.filter((c) => c.id !== cardId) })
    const inspect = useCallback((card, snapshot, row) => setEvidence({ card, snapshot, row }), [])
    const nodes = definition.cards.map((card) => ({
        id: card.id,
        type: 'dashboard',
        position: { x: card.x, y: card.y },
        data: {
            card,
            snapshot: record?.snapshot?.cards.find((s) => s.cardId === card.id),
            inspect,
            remove: editable && !busy ? remove : null,
            edit: editable && !busy ? (card) => setEditor({ ...card, paramsText: JSON.stringify(card.params, null, 2) }) : null
        },
        draggable: editable && !busy,
        selectable: false
    }))
    const add = (kind, position) => {
        if (!editable || busy || definition.cards.length >= 12) return
        setEditor({
            kind,
            title: '',
            source: sources[0]?.key || '',
            paramsText: '{}',
            scope: '',
            valueField: '',
            labelField: '',
            x: Math.max(0, Math.min(5000, position?.x || (definition.cards.length % 2) * 400)),
            y: Math.max(0, Math.min(5000, position?.y || Math.floor(definition.cards.length / 2) * 370))
        })
    }
    const commitCard = () => {
        try {
            const source = sources.find((s) => s.key === editor.source)
            const params = JSON.parse(editor.paramsText)
            if (!source || !editor.title.trim() || !editor.scope.trim() || !params || Array.isArray(params) || typeof params !== 'object')
                throw new Error('Choose a source, title, scope and parameter object.')
            if (editor.kind !== 'table' && !editor.valueField) throw new Error('Choose a numeric value field.')
            if (['bar', 'trend', 'donut'].includes(editor.kind) && !editor.labelField) throw new Error('Choose a label field.')
            const { paramsText: _paramsText, ...card } = editor
            const nextCard = { ...card, params, hash: source.hash, id: card.id || crypto.randomUUID() }
            change({ cards: card.id ? definition.cards.map((c) => (c.id === card.id ? nextCard : c)) : [...definition.cards, nextCard] })
            if (card.id && record) setRecord({ ...record, snapshot: null })
            setEditor(null)
            setError('')
        } catch (e) {
            setError(e.message)
        }
    }
    const save = async () => {
        const { data } = id
            ? await client.put(path(id), { definition, revision: record.revision })
            : await client.post('/dashflows', { definition })
        adopt(data)
        if (!id) navigate(`/dashflows/${data.id}`)
    }
    const source = sources.find((s) => s.key === editor?.source)
    const supremeReady = definition.harness === 'honeybadger-supreme' && sources.some((s) => s.name === 'pq_quarter_account_risk_patterns')
    const shareUrl = id ? `${window.location.origin}/dashboards/${id}` : ''
    return (
        <main className='df-root'>
            <div className='df-eyebrow'>
                <span className='df-dot' /> {definition.harness === 'honeybadger-supreme' ? 'SUPREME / DASH FLOWS' : 'DASH FLOWS'}{' '}
                <span className='df-beta'>SKUNKWORKS / MVP</span>
            </div>
            <header className='df-header'>
                <div>
                    <h1>{id ? definition.title : 'Your business. In focus.'}</h1>
                    <p>
                        {published
                            ? 'A published snapshot. Every number has a source.'
                            : definition.harness === 'honeybadger-supreme'
                            ? 'Renewal risk, made visible. Every account, one click from the evidence.'
                            : 'Pin the truth. Shape the story. Share the view.'}
                    </p>
                </div>
                <div className='df-actions'>
                    {!published && (
                        <Button
                            disabled={!id || dirty || busy || !definition.cards.length}
                            onClick={() => run(async () => adopt((await client.post(`${path(id)}/refresh`)).data))}
                            startIcon={<IconRefresh size={17} />}
                        >
                            Refresh
                        </Button>
                    )}
                    {editable && (
                        <>
                            <Button disabled={busy || !definition.harness || (!dirty && !!id)} onClick={() => run(save)}>
                                Save draft
                            </Button>
                            <Button
                                variant='contained'
                                disabled={busy || (!record?.published && (dirty || !record?.snapshot))}
                                onClick={() => setPublishDialog(true)}
                            >
                                Publish & share <IconArrowUpRight size={17} />
                            </Button>
                        </>
                    )}
                </div>
            </header>
            {error && (
                <Alert severity='error' onClose={() => setError('')}>
                    {error}
                </Alert>
            )}
            {notice && (
                <Alert severity='success' onClose={() => setNotice('')}>
                    {notice}
                </Alert>
            )}
            {record?.error && <Alert severity='warning'>{record.error}</Alert>}
            {editable && supremeReady && !definition.cards.length && (
                <Alert
                    severity='info'
                    action={
                        <Button disabled={busy} onClick={() => change(supremeRiskTemplate(sources))}>
                            Use Supreme risk view
                        </Button>
                    }
                >
                    Start with Supreme’s current-quarter renewal risk: cohort metrics, recorded-driver categories and a clickable priority
                    renewal watchlist.
                </Alert>
            )}
            <section className='df-toolbar'>
                {published ? (
                    <span className='df-tag'>Team access · published {date(record?.publishedAt)}</span>
                ) : (
                    <>
                        <TextField
                            size='small'
                            label='Dashboard'
                            select
                            value={id || ''}
                            onChange={(e) => navigate(e.target.value ? `/dashflows/${e.target.value}` : '/dashflows')}
                            disabled={busy || dirty}
                        >
                            <MenuItem value=''>New dashboard</MenuItem>
                            {dashboards.map((d) => (
                                <MenuItem key={d.id} value={d.id}>
                                    {d.definition.title}
                                </MenuItem>
                            ))}
                            {id && !dashboards.some((d) => d.id === id) && <MenuItem value={id}>{definition.title}</MenuItem>}
                        </TextField>
                        <TextField
                            size='small'
                            label='Title'
                            value={definition.title}
                            disabled={!editable || busy}
                            onChange={(e) => change({ title: e.target.value })}
                        />
                        <TextField
                            size='small'
                            select
                            label='Harness'
                            value={definition.harness}
                            disabled={!editable || busy || !!definition.cards.length}
                            onChange={(e) => change({ harness: e.target.value })}
                        >
                            {harnesses.map((h) => (
                                <MenuItem key={h.name} value={h.name}>
                                    {h.name}
                                </MenuItem>
                            ))}
                        </TextField>
                        <TextField
                            size='small'
                            select
                            label='Refresh draft'
                            value={definition.intervalSeconds}
                            disabled={!editable || busy}
                            onChange={(e) => change({ intervalSeconds: e.target.value })}
                        >
                            <MenuItem value={0}>On demand</MenuItem>
                            <MenuItem value={3600}>Every hour</MenuItem>
                            <MenuItem value={86400}>Every day</MenuItem>
                        </TextField>
                    </>
                )}
            </section>
            {definition.harness === 'honeybadger-supreme' && record?.snapshot && (
                <div className='df-supreme-context'>
                    <span>PINNED SOURCE</span>
                    <strong>Current-quarter renewal risk</strong>
                    <span>
                        {cell(record.snapshot.cards[0]?.rows[0]?.window_start)} →{' '}
                        {cell(record.snapshot.cards[0]?.rows[0]?.window_end_exclusive)} UTC · end excluded
                    </span>
                    <span>Source as of {cell(record.snapshot.cards[0]?.rows[0]?.source_as_of)}</span>
                </div>
            )}
            <div className='df-workspace'>
                {editable && (
                    <aside className='df-palette'>
                        <h2>BUILD YOUR VIEW</h2>
                        <p>Drag a card onto the canvas, or click to add.</p>
                        {[
                            ['metric', '01', 'Key metric', 'One exact source value'],
                            ['bar', '02', 'Bar chart', 'Compare returned values'],
                            ['trend', '03', 'Trend line', 'Follow source observations'],
                            ['donut', '04', 'Composition', 'Disjoint source categories'],
                            ['table', '05', 'Evidence table', 'Sort and explore accounts']
                        ].map(([kind, num, title, caption]) => (
                            <button
                                key={kind}
                                draggable={!!sources.length && !busy}
                                disabled={!sources.length || busy || definition.cards.length >= 12}
                                onDragStart={(e) => e.dataTransfer.setData('application/dashflow', kind)}
                                onClick={() => add(kind)}
                            >
                                <span>
                                    {num}
                                    <IconPlus size={15} />
                                </span>
                                <strong>{title}</strong>
                                <small>{caption}</small>
                            </button>
                        ))}
                        <div className='df-source-note'>
                            <IconShieldCheck size={20} />
                            <strong>Grounded by design</strong>
                            <p>Only saved, tested PostgreSQL pins. Exact inputs. No model-made numbers.</p>
                        </div>
                        {definition.harness && !sources.length && (
                            <p className='df-help'>
                                No eligible pins found. Test and publish a PostgreSQL query in this harness first. Secure parameters are
                                excluded.
                            </p>
                        )}
                    </aside>
                )}
                <div
                    className={`df-canvas ${published && compact ? 'df-stacked' : ''}`}
                    onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                    }}
                    onDrop={(e) => {
                        e.preventDefault()
                        const kind = e.dataTransfer.getData('application/dashflow')
                        if (['metric', 'bar', 'trend', 'donut', 'table'].includes(kind))
                            add(kind, flow?.screenToFlowPosition({ x: e.clientX, y: e.clientY }))
                    }}
                >
                    {published && compact ? (
                        nodes.map((node) => <DashboardCard key={node.id} data={node.data} />)
                    ) : (
                        <ReactFlow
                            nodes={nodes}
                            edges={[]}
                            nodeTypes={nodeTypes}
                            onInit={setFlow}
                            fitView
                            minZoom={0.25}
                            maxZoom={1.5}
                            nodesConnectable={false}
                            deleteKeyCode={null}
                            onNodeDragStop={(_e, node) =>
                                change({
                                    cards: definition.cards.map((c) =>
                                        c.id === node.id
                                            ? {
                                                  ...c,
                                                  x: Math.max(0, Math.min(5000, node.position.x)),
                                                  y: Math.max(0, Math.min(5000, node.position.y))
                                              }
                                            : c
                                    )
                                })
                            }
                        >
                            <Background color='#364446' gap={24} size={1} />
                            <Controls showInteractive={false} />
                        </ReactFlow>
                    )}
                    {!nodes.length && (
                        <div className='df-empty'>
                            <IconLayoutDashboard size={42} stroke={1.2} />
                            <h2>A clear view starts here.</h2>
                            <p>
                                {definition.harness
                                    ? 'Add a card. Bind a tested source. Bring your data into focus.'
                                    : 'Select a harness to discover its tested data sources.'}
                            </p>
                            <span>METRICS · BREAKDOWNS · EVIDENCE</span>
                        </div>
                    )}
                </div>
            </div>
            <footer className='df-footer'>
                <span>
                    <span className='df-dot' />{' '}
                    {busy ? 'Working…' : dirty ? 'Unsaved draft' : record?.snapshot ? 'Materialized snapshot' : 'Awaiting first refresh'}
                </span>
                <span>
                    {definition.cards.length} cards · {date(record?.snapshot?.refreshedAt)}
                    {record?.nextRefresh ? ` · Next draft refresh ${date(record.nextRefresh)}` : ''}
                </span>
            </footer>
            {!published && (
                <p className='df-footnote'>
                    Published links require team sign-in. Scheduled refreshes update the draft; publish again to release a new snapshot.
                </p>
            )}
            <Dialog open={!!editor} onClose={() => setEditor(null)} fullWidth maxWidth='sm'>
                <DialogTitle>Pin a source to your {editor?.kind}</DialogTitle>
                <DialogContent>
                    {editor && (
                        <div className='df-form'>
                            <TextField
                                label='Card title'
                                value={editor.title}
                                onChange={(e) => setEditor({ ...editor, title: e.target.value })}
                            />
                            <TextField
                                select
                                label='Tested query'
                                value={editor.source}
                                onChange={(e) => setEditor({ ...editor, source: e.target.value, valueField: '', labelField: '' })}
                            >
                                {sources.map((s) => (
                                    <MenuItem key={s.key} value={s.key}>
                                        {s.specialist} / {s.name}
                                    </MenuItem>
                                ))}
                            </TextField>
                            <p>{source?.purpose}</p>
                            <TextField
                                label='Business scope / period'
                                helperText='Your explicit scope label; confirm it matches the parameters.'
                                value={editor.scope}
                                onChange={(e) => setEditor({ ...editor, scope: e.target.value })}
                            />
                            <div className='df-parameter-grid'>
                                {source?.params.map((param) => {
                                    let params
                                    try {
                                        params = JSON.parse(editor.paramsText)
                                    } catch {
                                        return null
                                    }
                                    const value = params[param.name] ?? param.default ?? ''
                                    return (
                                        <TextField
                                            key={param.name}
                                            size='small'
                                            label={param.name.replaceAll('_', ' ')}
                                            type={
                                                param.type === 'date'
                                                    ? 'date'
                                                    : ['int8', 'numeric'].includes(param.type)
                                                    ? 'number'
                                                    : 'text'
                                            }
                                            select={param.type === 'bool' || Boolean(param.allowedValues)}
                                            InputLabelProps={{ shrink: true }}
                                            value={value}
                                            inputProps={{ min: param.min, max: param.max }}
                                            onChange={(e) => {
                                                const next = { ...params }
                                                const value = e.target.value
                                                if (value === '') delete next[param.name]
                                                else next[param.name] = ['int8', 'numeric'].includes(param.type) ? Number(value) : value
                                                setEditor({ ...editor, paramsText: JSON.stringify(next, null, 2) })
                                            }}
                                        >
                                            {param.type === 'bool'
                                                ? [
                                                      <MenuItem key='true' value={true}>
                                                          Yes
                                                      </MenuItem>,
                                                      <MenuItem key='false' value={false}>
                                                          No
                                                      </MenuItem>
                                                  ]
                                                : param.allowedValues?.map((value) => (
                                                      <MenuItem key={value} value={value}>
                                                          {value}
                                                      </MenuItem>
                                                  ))}
                                        </TextField>
                                    )
                                })}
                            </div>
                            {['bar', 'trend', 'donut'].includes(editor.kind) && (
                                <TextField
                                    label='Display sort'
                                    select
                                    value={editor.sort || 'source'}
                                    onChange={(e) => setEditor({ ...editor, sort: e.target.value })}
                                >
                                    <MenuItem value='source'>Source order</MenuItem>
                                    <MenuItem value='value-desc'>Value: high to low</MenuItem>
                                    <MenuItem value='value-asc'>Value: low to high</MenuItem>
                                </TextField>
                            )}
                            <TextField
                                multiline
                                minRows={3}
                                label='Exact parameters (JSON)'
                                helperText={
                                    source?.params.map((p) => `${p.name}: ${p.type}`).join(' · ') || 'This source has no parameters.'
                                }
                                value={editor.paramsText}
                                onChange={(e) => setEditor({ ...editor, paramsText: e.target.value })}
                            />
                            <TextField
                                label='Complete aggregate flag path (optional)'
                                helperText='Only for a one-row source envelope with an explicit boolean completeness field.'
                                value={editor.completePath || ''}
                                onChange={(e) => setEditor({ ...editor, completePath: e.target.value })}
                            />
                            <TextField
                                label='Nested row array path (optional)'
                                helperText='For example risk_pattern_payload.patterns. Requires the completeness flag.'
                                value={editor.rowsPath || ''}
                                onChange={(e) => setEditor({ ...editor, rowsPath: e.target.value })}
                            />
                            {editor.kind !== 'table' && (
                                <TextField
                                    label='Value field'
                                    select={Boolean(source?.columns.length) && !editor.rowsPath}
                                    value={editor.valueField}
                                    onChange={(e) => setEditor({ ...editor, valueField: e.target.value })}
                                >
                                    {source?.columns.map((c) => (
                                        <MenuItem key={c.name} value={c.name}>
                                            {c.name} ({c.type})
                                        </MenuItem>
                                    ))}
                                </TextField>
                            )}
                            {['bar', 'trend', 'donut'].includes(editor.kind) && (
                                <TextField
                                    label='Label field'
                                    select={Boolean(source?.columns.length) && !editor.rowsPath}
                                    value={editor.labelField}
                                    onChange={(e) => setEditor({ ...editor, labelField: e.target.value })}
                                >
                                    {source?.columns.map((c) => (
                                        <MenuItem key={c.name} value={c.name}>
                                            {c.name}
                                        </MenuItem>
                                    ))}
                                </TextField>
                            )}
                            {error && <Alert severity='error'>{error}</Alert>}
                        </div>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setEditor(null)}>Cancel</Button>
                    <Button variant='contained' onClick={commitCard}>
                        {editor?.id ? 'Apply filters & settings' : 'Add to canvas'}
                    </Button>
                </DialogActions>
            </Dialog>
            <Drawer anchor='right' open={!!evidence} onClose={() => setEvidence(null)}>
                <div className='df-drawer'>
                    <span className='df-eyebrow'>THE EVIDENCE</span>
                    <h2>{evidence?.card.title}</h2>
                    <Button onClick={() => setEvidence(null)}>Close</Button>
                    {evidence && (
                        <>
                            <p>{evidence.card.scope}</p>
                            <Alert severity='info'>
                                Pinned execution verified. Business scope and parameter selection are author supplied; they are not
                                independently certified.
                            </Alert>
                            {evidence.row !== undefined && accountIdentity(evidence.snapshot.rows[evidence.row]) && (
                                <AccountReport
                                    key={evidence.snapshot.rows[evidence.row].account_id}
                                    row={evidence.snapshot.rows[evidence.row]}
                                    harness={definition.harness}
                                    canRun={hasPermission('chatflows:create,chatflows:update,agentflows:create')}
                                />
                            )}
                            <dl>
                                <dt>Harness / query</dt>
                                <dd>
                                    {evidence.snapshot.source.harness} / {evidence.snapshot.source.pin}
                                </dd>
                                <dt>Source version</dt>
                                <dd>{evidence.snapshot.source.version}</dd>
                                <dt>Refreshed</dt>
                                <dd>{date(evidence.snapshot.fetchedAt)}</dd>
                                <dt>Query fingerprint</dt>
                                <dd className='df-hash'>{evidence.snapshot.source.hash}</dd>
                                <dt>Source row projection</dt>
                                <dd>{evidence.snapshot.source.rowsPath || 'Top-level source rows'}</dd>
                                <dt>Source completeness assertion</dt>
                                <dd>{evidence.snapshot.source.completenessPath || 'Complete bounded query result'}</dd>
                                <dt>Exact parameters</dt>
                                <dd>
                                    <pre>{JSON.stringify(evidence.snapshot.source.params, null, 2)}</pre>
                                </dd>
                            </dl>
                            <h3>
                                {evidence.row !== undefined
                                    ? `Source row ${evidence.row + 1}`
                                    : `${evidence.snapshot.rows.length} source rows`}
                            </h3>
                            <SourceTable
                                rows={evidence.row !== undefined ? [evidence.snapshot.rows[evidence.row]] : evidence.snapshot.rows}
                            />
                            {evidence.snapshot.evidenceRows && (
                                <details>
                                    <summary>Original source envelope (scope and coverage)</summary>
                                    <SourceTable rows={evidence.snapshot.evidenceRows} />
                                </details>
                            )}
                        </>
                    )}
                </div>
            </Drawer>
            <Dialog open={publishDialog} onClose={() => setPublishDialog(false)} fullWidth>
                <DialogTitle>Share a view people can trust.</DialogTitle>
                <DialogContent>
                    <p>
                        Publish this saved snapshot for signed-in members of the current team with dashboard viewing access. Later draft
                        edits stay private to the builder view.
                    </p>
                    <TextField fullWidth label='Team dashboard link' value={shareUrl} InputProps={{ readOnly: true }} />
                    <p>This is a snapshot, not a live query. Anyone opening the link reads stored data.</p>
                </DialogContent>
                <DialogActions>
                    {record?.published && (
                        <Button
                            color='error'
                            onClick={() =>
                                run(async () => {
                                    await client.delete(`${path(id)}/publish`)
                                    setRecord({ ...record, published: false })
                                    setPublishDialog(false)
                                    setNotice('Dashboard unpublished. The shared view is now unavailable.')
                                })
                            }
                        >
                            Unpublish
                        </Button>
                    )}
                    <Button onClick={() => setPublishDialog(false)}>Cancel</Button>
                    <Button
                        variant='contained'
                        disabled={busy || dirty || !record?.snapshot}
                        onClick={() =>
                            run(async () => {
                                await client.post(`${path(id)}/publish`, { revision: record.revision })
                                setRecord({ ...record, published: true })
                                setPublishDialog(false)
                                try {
                                    await navigator.clipboard.writeText(shareUrl)
                                    setNotice('Published. Team link copied.')
                                } catch {
                                    setNotice(`Published. Team link: ${shareUrl}`)
                                }
                            })
                        }
                    >
                        Publish snapshot & copy link
                    </Button>
                </DialogActions>
            </Dialog>
        </main>
    )
}
DashFlows.propTypes = { published: PropTypes.bool }
