import { useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { Controls, Background } from 'reactflow'
import 'reactflow/dist/style.css'
import '@/views/canvas/index.css'

import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'

// material-ui
import {
    Alert,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    AppBar,
    Avatar,
    Box,
    ButtonBase,
    Paper,
    Stack,
    ToggleButton,
    ToggleButtonGroup,
    Toolbar,
    Typography,
    useMediaQuery
} from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { IconChevronLeft, IconRestore } from '@tabler/icons-react'

// project imports
import MarketplaceCanvasNode from '@/views/marketplaces/MarketplaceCanvasNode'
import StickyNote from '@/views/canvas/StickyNote'
import AgentFlowNode from '@/views/agentflowsv2/AgentFlowNode'
import AgentFlowEdge from '@/views/agentflowsv2/AgentFlowEdge'
import IterationNode from '@/views/agentflowsv2/IterationNode'
import AgentStickyNote from '@/views/agentflowsv2/StickyNote'
import flowDraftsApi from '@/api/flowDrafts'
import flowVersionsApi from '@/api/flowVersions'
import chatflowsApi from '@/api/chatflows'
import { flowContext } from '@/store/context/ReactFlowContext'
import { Available } from '@/ui-component/rbac/available'
import { enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'
import { restorePrompt } from '@/utils/flowDrafts'
import {
    CHANGE_COLORS,
    ambiguousCredentialText,
    backPathFor,
    restoreMessage,
    decorateNodes,
    describeDiff,
    exactTime,
    hiddenSecretText,
    isAgentflowV2
} from '@/utils/versionHistory'

const v1NodeTypes = { customNode: MarketplaceCanvasNode, stickyNote: StickyNote }
const v1EdgeTypes = { buttonedge: '' }
const v2NodeTypes = { agentFlow: AgentFlowNode, stickyNote: AgentStickyNote, iteration: IterationNode }
const v2EdgeTypes = { agentFlow: AgentFlowEdge }

const LINE_COLORS = { added: CHANGE_COLORS.added, changed: CHANGE_COLORS.changed, removed: '#c62828', moved: '#757575' }

const errorMessage = (error, fallback) => error?.response?.data?.message || fallback

// The node and edge components come from the editors. On this page every editing action they reach through
// the flow context does nothing, and the editing buttons are hidden (see READ_ONLY_SX).
const noop = () => undefined
const READ_ONLY_SX = {
    '& .edgebutton-foreignobject, & [title="Delete"], & [title="Duplicate"]': { display: 'none !important' },
    '& .react-flow__node input, & .react-flow__node textarea': { pointerEvents: 'none' }
}

// ==============================|| VERSION VIEWER ||============================== //

// A read-only canvas of one saved version, with what changed outlined.
const VersionCanvas = () => {
    const theme = useTheme()
    // Below sm the buttons use short labels; below md they move to a second row under the title.
    const compact = useMediaQuery(theme.breakpoints.down('sm'))
    const navigate = useNavigate()
    const { chatflowId, sha } = useParams()
    const customization = useSelector((state) => state.customization)
    const reactFlowWrapper = useRef(null)
    const location = useLocation()
    const [flowType, setFlowType] = useState(null)
    const [draftMode, setDraftMode] = useState(Boolean(location.state?.draftMode))
    const [viewerInstance, setViewerInstance] = useState(null)
    const readOnlyContext = useMemo(
        () => ({
            reactFlowInstance: viewerInstance,
            setReactFlowInstance: noop,
            deleteNode: noop,
            deleteEdge: noop,
            duplicateNode: noop,
            onAgentflowNodeStatusUpdate: noop,
            clearAgentflowNodeStatus: noop,
            onNodeDataChange: noop
        }),
        [viewerInstance]
    )

    // The flow's own type, for the back button when the version cannot be loaded.
    useEffect(() => {
        let cancelled = false
        setFlowType(null)
        chatflowsApi
            .getSpecificChatflow(chatflowId)
            .then((res) => !cancelled && setFlowType(res.data?.type || null))
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [chatflowId])

    useEffect(() => {
        let cancelled = false
        flowDraftsApi
            .getStatus(chatflowId)
            .then((res) => !cancelled && setDraftMode(res.data?.mode === 'draft'))
            .catch(() => !cancelled && setDraftMode(false))
        return () => {
            cancelled = true
        }
    }, [chatflowId])

    const dispatch = useDispatch()
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [restoring, setRestoring] = useState(false)
    const [restoreError, setRestoreError] = useState(null)
    const prompt = restorePrompt(draftMode)

    const [version, setVersion] = useState(null)
    const [loadError, setLoadError] = useState(null)
    const [against, setAgainst] = useState('previous')
    const [diff, setDiff] = useState(null)
    const [diffError, setDiffError] = useState(null)
    const [entry, setEntry] = useState(null)

    useEffect(() => {
        let cancelled = false
        setVersion(null)
        setLoadError(null)
        flowVersionsApi
            .getVersion(chatflowId, sha)
            .then((res) => !cancelled && setVersion(res.data))
            .catch((error) => !cancelled && setLoadError(errorMessage(error, 'This version could not be loaded.')))
        return () => {
            cancelled = true
        }
    }, [chatflowId, sha])

    useEffect(() => {
        let cancelled = false
        setEntry(null)
        flowVersionsApi
            .listVersions(chatflowId)
            .then((res) => {
                if (cancelled) return
                const versions = res.data?.versions || []
                setEntry(versions.find((item) => item.sha.startsWith(sha)) || null)
            })
            .catch(() => undefined)
        return () => {
            cancelled = true
        }
    }, [chatflowId, sha])

    useEffect(() => {
        let cancelled = false
        setDiff(null)
        setDiffError(null)
        flowVersionsApi
            .diffVersion(chatflowId, sha, against)
            .then((res) => !cancelled && setDiff(res.data))
            .catch((error) => !cancelled && setDiffError(errorMessage(error, 'Changes could not be loaded.')))
        return () => {
            cancelled = true
        }
    }, [chatflowId, sha, against])

    const flow = useMemo(() => {
        if (!version?.flowData) return { nodes: [], edges: [] }
        try {
            const parsed = JSON.parse(version.flowData)
            return {
                nodes: Array.isArray(parsed?.nodes) ? parsed.nodes : [],
                edges: Array.isArray(parsed?.edges) ? parsed.edges : []
            }
        } catch {
            return { nodes: [], edges: [] }
        }
    }, [version])

    const nodes = useMemo(() => decorateNodes(flow.nodes, diff), [flow.nodes, diff])
    const lines = useMemo(() => describeDiff(diff, against, flow.nodes), [diff, against, flow.nodes])
    const v2 = isAgentflowV2(version?.type)
    const backPath = backPathFor(chatflowId, version?.type, location.state?.type, flowType)
    const firstVersion = against === 'previous' && diff && diff.against === null

    const restore = async () => {
        setRestoring(true)
        setRestoreError(null)
        try {
            const res = await flowVersionsApi.restoreVersion(chatflowId, sha)
            const { message, variant } = restoreMessage(res.data)
            dispatch(
                enqueueSnackbarAction({
                    message,
                    options: { key: new Date().getTime() + Math.random(), variant }
                })
            )
            setConfirmOpen(false)
            navigate(backPathFor(chatflowId, res.data?.chatflow?.type, version?.type, location.state?.type, flowType))
        } catch (error) {
            setRestoreError(errorMessage(error, 'This version could not be restored.'))
        } finally {
            setRestoring(false)
        }
    }

    return (
        <Box>
            <AppBar enableColorOnDark position='fixed' color='inherit' elevation={1} sx={{ bgcolor: theme.palette.background.default }}>
                <Toolbar sx={{ flexWrap: { xs: 'wrap', md: 'nowrap' }, rowGap: 1, py: { xs: 1, md: 0 } }}>
                    <ButtonBase
                        title='Back to editing'
                        disabled={!backPath}
                        sx={{ borderRadius: '50%', flexShrink: 0 }}
                        onClick={() => backPath && navigate(backPath)}
                    >
                        <Avatar
                            variant='rounded'
                            sx={{
                                ...theme.typography.commonAvatar,
                                ...theme.typography.mediumAvatar,
                                background: theme.palette.secondary.light,
                                color: theme.palette.secondary.dark
                            }}
                        >
                            <IconChevronLeft stroke={1.5} size='1.3rem' />
                        </Avatar>
                    </ButtonBase>
                    <Box sx={{ flexGrow: 1, ml: 2, minWidth: 0, flexBasis: { xs: 'calc(100% - 64px)', md: 'auto' } }}>
                        <Typography sx={{ fontSize: '1.25rem', fontWeight: 600 }} noWrap>
                            {version ? version.name : 'Version'}
                        </Typography>
                        <Typography variant='body2' color='text.secondary' noWrap title={entry ? entry.title : undefined}>
                            {entry ? `${entry.title} · ${exactTime(entry.date)} · ` : ''}Read-only version {String(sha).slice(0, 7)}
                        </Typography>
                    </Box>
                    <ToggleButtonGroup
                        size='small'
                        exclusive
                        value={against}
                        onChange={(_event, value) => value && setAgainst(value)}
                        aria-label='Compare with'
                        // Only the title shrinks: a long version name must not wrap these buttons or grow the bar.
                        sx={{ flexShrink: 0, ml: { xs: 0, md: 2 }, '& .MuiToggleButton-root': { whiteSpace: 'nowrap' } }}
                    >
                        <ToggleButton value='previous'>{compact ? 'This version' : 'Changes in this version'}</ToggleButton>
                        <ToggleButton value='current'>{compact ? 'Now' : 'Compare with now'}</ToggleButton>
                    </ToggleButtonGroup>
                    {version && (
                        <Available permission={'chatflows:update,agentflows:update'}>
                            <Button
                                variant='contained'
                                color='secondary'
                                startIcon={<IconRestore size='1.1rem' />}
                                sx={{ ml: 2, borderRadius: 2, flexShrink: 0, whiteSpace: 'nowrap' }}
                                onClick={() => setConfirmOpen(true)}
                            >
                                {compact ? prompt.shortButton : prompt.button}
                            </Button>
                        </Available>
                    )}
                </Toolbar>
            </AppBar>
            <Box sx={{ pt: { xs: '120px', md: '70px' }, height: '100vh', width: '100%', position: 'relative' }}>
                {loadError && (
                    <Alert severity='error' sx={{ m: 2 }}>
                        {loadError}
                    </Alert>
                )}
                <div className='reactflow-parent-wrapper'>
                    <Box className='reactflow-wrapper' ref={reactFlowWrapper} sx={READ_ONLY_SX}>
                        {version && (
                            <flowContext.Provider value={readOnlyContext}>
                                <ReactFlow
                                    key={`${sha}-${against}`}
                                    nodes={nodes}
                                    edges={flow.edges}
                                    nodesDraggable={false}
                                    nodesConnectable={false}
                                    elementsSelectable={false}
                                    nodeTypes={v2 ? v2NodeTypes : v1NodeTypes}
                                    edgeTypes={v2 ? v2EdgeTypes : v1EdgeTypes}
                                    fitView
                                    onInit={setViewerInstance}
                                    minZoom={0.1}
                                >
                                    <Controls
                                        className={customization.isDarkMode ? 'dark-mode-controls' : ''}
                                        showInteractive={false}
                                        style={{ display: 'flex', flexDirection: 'row', left: '50%', transform: 'translate(-50%, -50%)' }}
                                    />
                                    <Background color='#aaa' gap={16} />
                                </ReactFlow>
                            </flowContext.Provider>
                        )}
                    </Box>
                </div>
                {version && (
                    <Paper
                        elevation={3}
                        sx={{
                            position: 'absolute',
                            top: { xs: 136, md: 86 },
                            right: 16,
                            width: 320,
                            maxHeight: '70vh',
                            overflowY: 'auto',
                            p: 2,
                            zIndex: 5
                        }}
                        aria-label='What changed'
                    >
                        <Typography variant='h5' sx={{ mb: 1 }}>
                            {against === 'current' ? 'Different from now' : 'What changed'}
                        </Typography>
                        {diffError && <Alert severity='error'>{diffError}</Alert>}
                        {!diffError && !diff && (
                            <Typography variant='body2' color='text.secondary'>
                                Loading changes…
                            </Typography>
                        )}
                        {firstVersion && (
                            <Typography variant='body2' color='text.secondary'>
                                This is the first saved version.
                            </Typography>
                        )}
                        {diff && !firstVersion && lines.length === 0 && (
                            <Typography variant='body2' color='text.secondary'>
                                {against === 'current' ? 'Same as now.' : 'No content changes.'}
                            </Typography>
                        )}
                        <Stack spacing={0.75}>
                            {!firstVersion &&
                                lines.map((line, index) => (
                                    <Stack key={index} direction='row' spacing={1} alignItems='flex-start'>
                                        <Box
                                            sx={{
                                                mt: '6px',
                                                width: 10,
                                                height: 10,
                                                borderRadius: '50%',
                                                flexShrink: 0,
                                                bgcolor: LINE_COLORS[line.status]
                                            }}
                                        />
                                        <Typography variant='body2' sx={{ wordBreak: 'break-word' }}>
                                            {line.text}
                                        </Typography>
                                    </Stack>
                                ))}
                        </Stack>
                        {version.missingCredentials?.length > 0 && (
                            <Alert severity='warning' sx={{ mt: 1.5 }}>
                                Not in this workspace: {version.missingCredentials.map((ref) => ref.name).join(', ')}. Add a credential with
                                that name to use this version.
                            </Alert>
                        )}
                        {version.ambiguousCredentials?.length > 0 && (
                            <Alert severity='info' sx={{ mt: 1.5 }}>
                                {ambiguousCredentialText(version.ambiguousCredentials)}
                            </Alert>
                        )}
                        {version.hiddenSecrets?.length > 0 && (
                            <Alert severity='warning' sx={{ mt: 1.5 }}>
                                {hiddenSecretText(version.hiddenSecrets)}
                            </Alert>
                        )}
                        <Stack direction='row' spacing={2} sx={{ mt: 1.5 }}>
                            <Typography variant='caption' sx={{ color: CHANGE_COLORS.added, fontWeight: 600 }}>
                                ■ Added
                            </Typography>
                            <Typography variant='caption' sx={{ color: CHANGE_COLORS.changed, fontWeight: 600 }}>
                                ■ Changed
                            </Typography>
                        </Stack>
                    </Paper>
                )}
            </Box>
            <Dialog open={confirmOpen} onClose={() => !restoring && setConfirmOpen(false)} maxWidth='xs' fullWidth>
                <DialogTitle sx={{ fontSize: '1.1rem' }}>{prompt.title}</DialogTitle>
                <DialogContent>
                    <Typography variant='body2'>{prompt.body}</Typography>
                    {version?.missingCredentials?.length > 0 && (
                        <Alert severity='warning' sx={{ mt: 1.5 }}>
                            Not in this workspace: {version.missingCredentials.map((ref) => ref.name).join(', ')}. Those nodes come back
                            with no credential selected.
                        </Alert>
                    )}
                    {version?.ambiguousCredentials?.length > 0 && (
                        <Alert severity='info' sx={{ mt: 1.5 }}>
                            {ambiguousCredentialText(version.ambiguousCredentials)}
                        </Alert>
                    )}
                    {version?.hiddenSecrets?.length > 0 && (
                        <Alert severity='warning' sx={{ mt: 1.5 }}>
                            {hiddenSecretText(version.hiddenSecrets)}
                        </Alert>
                    )}
                    {restoreError && (
                        <Alert severity='error' sx={{ mt: 1.5 }}>
                            {restoreError}
                        </Alert>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setConfirmOpen(false)} disabled={restoring}>
                        Cancel
                    </Button>
                    <Button variant='contained' onClick={restore} disabled={restoring}>
                        {restoring ? 'Restoring…' : prompt.confirm}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    )
}

export default VersionCanvas
