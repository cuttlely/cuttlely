import { useEffect, useMemo, useRef, useState, useCallback, useContext } from 'react'
import ReactFlow, { addEdge, Controls, MiniMap, Background, ReactFlowProvider, useNodesState, useEdgesState } from 'reactflow'
import 'reactflow/dist/style.css'
import './index.css'
import { useReward } from 'react-rewards'

import { useDispatch, useSelector } from 'react-redux'
import { useNavigate, useLocation } from 'react-router-dom'
import {
    REMOVE_DIRTY,
    SET_DIRTY,
    SET_CHATFLOW,
    enqueueSnackbar as enqueueSnackbarAction,
    closeSnackbar as closeSnackbarAction
} from '@/store/actions'
import { cloneDeep } from 'lodash'

// material-ui
import { Toolbar, Box, AppBar, Button, Fab } from '@mui/material'
import { useTheme } from '@mui/material/styles'

// project imports
import CanvasNode from './AgentFlowNode'
import IterationNode from './IterationNode'
import AgentFlowEdge from './AgentFlowEdge'
import ConnectionLine from './ConnectionLine'
import StickyNote from './StickyNote'
import CanvasHeader from '@/views/canvas/CanvasHeader'
import { untrustFlow } from '@/utils/importVerify'
import CanvasLoadGuard, {
    canvasLoadBlocked,
    canvasLoadRetryRequest,
    createdFlowRouteAction,
    flowLoadAction
} from '@/views/canvas/CanvasLoadGuard'
import AddNodes from '@/views/canvas/AddNodes'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import DraftConflictDialog from '@/ui-component/dialog/DraftConflictDialog'
import EditNodeDialog from '@/views/agentflowsv2/EditNodeDialog'
import ChatPopUp from '@/views/chatmessage/ChatPopUp'
import ScheduleHistoryFAB from '@/views/schedule/ScheduleHistoryFAB'
import WebhookListenerFAB from '@/views/webhooklistener/WebhookListenerFAB'
import ValidationPopUp from '@/views/chatmessage/ValidationPopUp'
import { flowContext } from '@/store/context/ReactFlowContext'
import { CanvasPanelContext } from '@/store/context/CanvasPanelContext'

// API
import nodesApi from '@/api/nodes'
import chatflowsApi from '@/api/chatflows'
import flowDraftsApi from '@/api/flowDrafts'

// Hooks
import useApi from '@/hooks/useApi'
import useCanvasOpenRequest from '@/hooks/useCanvasOpenRequest'
import useConfirm from '@/hooks/useConfirm'
import useCanvasLook from '@/hooks/useCanvasLook'
import useSaveQueue from '@/hooks/useSaveQueue'
import { isNewLook, panelNode } from '@/utils/canvasLook'
import { createCanvasDeleteQueue, panelStateWhenNodesChange } from '@/views/canvas/cardActions'

// icons
import {
    IconX,
    IconRefreshAlert,
    IconMagnetFilled,
    IconMagnetOff,
    IconArtboard,
    IconArtboardOff,
    IconLayoutSidebarRight,
    IconLayoutSidebarRightFilled
} from '@tabler/icons-react'

// utils
import {
    getUniqueNodeLabel,
    getUniqueNodeId,
    initNode,
    updateOutdatedNodeData,
    updateOutdatedNodeEdge,
    isValidConnectionAgentflowV2
} from '@/utils/genericHelper'
import { anyNeedsSync, needsSync } from '@/utils/edgeRefs'
import useNotifier from '@/utils/useNotifier'
import { usePrompt } from '@/utils/usePrompt'
import { canvasFlowText, canvasTextToApply, draftStatusOpenDecision, planCanvasSave } from '@/utils/flowDrafts'
import { adoptImportedIdentity, draftStatusWhenImportUnknown } from '@/utils/importVerify'
import { canvasSaveDocument, liveSavePreflightForRoute } from '@/utils/canvasSave'
import {
    canvasIsEmpty,
    missingCredentialsText,
    starterQuestionsAfterCreate,
    starterQuestionsSaveEntry,
    stashNewCanvas,
    takeLanding,
    withStarterQuestions
} from '@/utils/buildWithAI'
import { templateSettingsMessage } from '@/utils/templateSettingsNote'
import BuildLandingDialog from '@/ui-component/dialog/BuildLandingDialog'

// const
import { AGENTFLOW_ICONS, uiBaseURL } from '@/store/constant'
import { requestFailureMessage, saveFailureMessage } from '@/utils/errorSummary'

const nodeTypes = { agentFlow: CanvasNode, stickyNote: StickyNote, iteration: IterationNode }
const edgeTypes = { agentFlow: AgentFlowEdge }

// ==============================|| CANVAS ||============================== //

const AgentflowCanvas = () => {
    const theme = useTheme()
    const navigate = useNavigate()
    const customization = useSelector((state) => state.customization)

    const { state } = useLocation()
    const templateFlowData = state ? state.templateFlowData : ''

    const URLpath = document.location.pathname.toString().split('/')
    const chatflowId =
        URLpath[URLpath.length - 1] === 'canvas' || URLpath[URLpath.length - 1] === 'agentcanvas' ? '' : URLpath[URLpath.length - 1]
    const canvasTitle = URLpath.includes('agentcanvas') ? 'Agent' : 'Chatflow'

    const { confirm } = useConfirm()

    const dispatch = useDispatch()
    const canvas = useSelector((state) => state.canvas)
    const canvasRef = useRef(canvas)
    canvasRef.current = canvas
    const [canvasDataStore, setCanvasDataStore] = useState(canvas)
    const [chatflow, setChatflow] = useState(null)
    const [draftStatus, setDraftStatusState] = useState(null)
    const [draftStatusLoad, setDraftStatusLoad] = useState({ flowId: null, known: false, loading: false, error: null })
    const [draftStatusRetry, setDraftStatusRetry] = useState(0)
    const draftStatusRef = useRef(null)
    const pendingSaveNameRef = useRef('')
    // A flow this canvas just created. Its new URL must not reload it from the server over newer edits.
    const createdFlowIdRef = useRef(null)
    // The flow this canvas is on. chatflowId is read from the address on every render, and create sets the new
    // address before its state updates render; createdFlowIdRef also covers a render that reads the address first.
    const routeFlowId = chatflowId || createdFlowIdRef.current
    const routeFlowIdRef = useRef(routeFlowId)
    routeFlowIdRef.current = routeFlowId
    const openRequest = useCanvasOpenRequest()
    const abortOpenRequest = openRequest.abort
    // A newly created flow is still the same queue scope. Moving between saved routes is not: disposing the old
    // queue prevents a late save from recording its draft base or callbacks on the newly opened canvas.
    const saveQueueRouteKey = createdFlowIdRef.current === chatflowId ? '' : chatflowId
    const draftSave = useSaveQueue({
        chatflowsApi,
        flowDraftsApi,
        dispatch,
        enqueueSnackbar: enqueueSnackbarAction,
        closeSnackbar: closeSnackbarAction,
        openRequestSignalFor: openRequest.signalFor,
        routeKey: saveQueueRouteKey
    })
    const canvasBlocked = canvasLoadBlocked(routeFlowId, draftStatusLoad)
    const setDraftStatus = (status) => {
        draftStatusRef.current = status
        setDraftStatusState(status)
    }
    const { reactFlowInstance, setReactFlowInstance, deleteSelection, applyingDelete, bindCanvasState } = useContext(flowContext)
    // Build with AI: starter questions wait here until the first save puts them in the chat settings.
    const builderStartersRef = useRef([])
    const [builtResult, setBuiltResult] = useState(null)

    // ==============================|| Snackbar ||============================== //

    useNotifier()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    // ==============================|| ReactFlow ||============================== //

    const [nodes, setNodes, onNodesChange] = useNodesState()
    // Keyboard Delete and Backspace emit remove changes. Those go through deleteNode and deleteEdge. The pipeline
    // canvas uses the chatflow handler, which does the same.
    // New look: a click on a card opens its settings in a side panel instead of the dialog.
    const [canvasLook, setCanvasLook] = useCanvasLook()
    const newLook = isNewLook(canvasLook)
    const [panelNodeId, setPanelNodeId] = useState(null)
    const [panelProps, setPanelProps] = useState({})
    const [edges, setEdges, onEdgesChange] = useEdgesState()
    bindCanvasState(setNodes, setEdges)
    const deleteSelectionRef = useRef(deleteSelection)
    deleteSelectionRef.current = deleteSelection
    const deleteQueue = useMemo(() => createCanvasDeleteQueue((batch) => deleteSelectionRef.current?.(batch)), [])
    const handleNodesChange = useCallback(
        (changes) => {
            if (applyingDelete?.current) onNodesChange(changes)
            else deleteQueue.nodes(changes, onNodesChange)
        },
        [applyingDelete, deleteQueue, onNodesChange]
    )
    const handleEdgesChange = useCallback(
        (changes) => {
            if (applyingDelete?.current) onEdgesChange(changes)
            else deleteQueue.edges(changes, onEdgesChange)
        },
        [applyingDelete, deleteQueue, onEdgesChange]
    )

    const isScheduleFlow = useMemo(() => {
        if (!nodes || nodes.length === 0) return false
        const startNode = nodes.find((n) => n.data?.name === 'startAgentflow')
        return startNode?.data?.inputs?.startInputType === 'scheduleInput'
    }, [nodes])

    const isWebhookFlow = useMemo(() => {
        if (!nodes || nodes.length === 0) return false
        const startNode = nodes.find((n) => n.data?.name === 'startAgentflow')
        return startNode?.data?.inputs?.startInputType === 'webhookTrigger'
    }, [nodes])

    const [selectedNode, setSelectedNode] = useState(null)
    const [isSyncNodesButtonEnabled, setIsSyncNodesButtonEnabled] = useState(false)
    const [editNodeDialogOpen, setEditNodeDialogOpen] = useState(false)
    const [editNodeDialogProps, setEditNodeDialogProps] = useState({})
    const [isSnappingEnabled, setIsSnappingEnabled] = useState(false)
    const [isBackgroundEnabled, setIsBackgroundEnabled] = useState(true)

    const reactFlowWrapper = useRef(null)

    // ==============================|| Chatflow API ||============================== //

    const getNodesApi = useApi(nodesApi.getAllNodes)
    const [duplicateSourceId, setDuplicateSourceId] = useState('')
    const getSpecificChatflowApi = useApi(chatflowsApi.getSpecificChatflow, { currentOnly: true })
    // The flow id of the latest saved-flow request; a result counts only while it matches the route (flowLoadAction).
    const requestedFlowIdRef = useRef(null)
    const requestFlow = (id) => {
        requestedFlowIdRef.current = id
        getSpecificChatflowApi.request(id, { signal: openRequest.start(id) })
    }

    // ==============================|| Events & Actions ||============================== //

    const onConnect = (params) => {
        if (!isValidConnectionAgentflowV2(params, reactFlowInstance)) {
            return
        }

        const nodeName = params.sourceHandle.split('_')[0]
        const targetNodeName = params.targetHandle.split('_')[0]

        const targetColor = AGENTFLOW_ICONS.find((icon) => icon.name === targetNodeName)?.color ?? theme.palette.primary.main
        const sourceColor = AGENTFLOW_ICONS.find((icon) => icon.name === nodeName)?.color ?? theme.palette.primary.main

        let edgeLabel = undefined
        if (nodeName === 'conditionAgentflow' || nodeName === 'conditionAgentAgentflow') {
            const _edgeLabel = params.sourceHandle.split('-').pop()
            edgeLabel = (isNaN(_edgeLabel) ? 0 : _edgeLabel).toString()
        }

        if (nodeName === 'humanInputAgentflow') {
            edgeLabel = params.sourceHandle.split('-').pop()
            edgeLabel = edgeLabel === '0' ? 'proceed' : 'reject'
        }

        // Check if both source and target nodes are within the same iteration node
        const sourceNode = reactFlowInstance.getNodes().find((node) => node.id === params.source)
        const targetNode = reactFlowInstance.getNodes().find((node) => node.id === params.target)
        const isWithinIterationNode = sourceNode?.parentNode && targetNode?.parentNode && sourceNode.parentNode === targetNode.parentNode

        const newEdge = {
            ...params,
            data: {
                ...params.data,
                sourceColor,
                targetColor,
                edgeLabel,
                isHumanInput: nodeName === 'humanInputAgentflow'
            },
            ...(isWithinIterationNode && { zIndex: 9999 }),
            type: 'agentFlow',
            id: `${params.source}-${params.sourceHandle}-${params.target}-${params.targetHandle}`
        }
        setEdges((eds) => addEdge(newEdge, eds))
    }

    const handleLoadFlow = (file) => {
        try {
            const flowData = JSON.parse(file)
            const graph = flowData && flowData.cuttlelyMigration && flowData.flow ? flowData.flow : flowData
            const cleared = untrustFlow(graph)
            const nodes = cleared.nodes || []

            setNodes(nodes)
            setEdges(cleared.edges || [])
            setTimeout(() => setDirty(), 0)
        } catch (e) {
            console.error(e)
        }
    }

    const handleDeleteFlow = async () => {
        const confirmPayload = {
            title: `Delete`,
            description: `Delete ${canvasTitle} ${chatflow.name}?`,
            confirmButtonName: 'Delete',
            cancelButtonName: 'Cancel'
        }
        const isConfirmed = await confirm(confirmPayload)

        if (isConfirmed) {
            try {
                await chatflowsApi.deleteChatflow(chatflow.id)
                localStorage.removeItem(`${chatflow.id}_INTERNAL`)
                navigate('/agentflows')
            } catch (error) {
                enqueueSnackbar({
                    message: requestFailureMessage(error),
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'error',
                        persist: true,
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
            }
        }
    }

    const reloadSharedDraft = () => {
        draftSave.dismiss()
        if (!chatflow?.id) return
        requestFlow(chatflow.id)
    }

    // The settings panel and the edit dialog hold the card object they opened with. A canvas that replaces every
    // card closes them, so a later edit cannot go to a card that is no longer on the canvas.
    const closeCardEditors = () => {
        setPanelNodeId(null)
        setPanelProps({})
        setEditNodeDialogOpen(false)
    }

    // The merged canvas from the conflict review screen. It replaces the cards and stays unsaved, so the
    // next Save sends the hash of the draft the other person saved.
    const applyMergedDraft = (text, theirs) => {
        if (!canvasTextToApply(text)) return
        try {
            const flow = readGraph(text)
            setNodes(flow.nodes || [])
            setEdges(flow.edges || [])
        } catch {
            return
        }
        closeCardEditors()
        draftSave.adopt(theirs)
        if (theirs?.status) setDraftStatus(theirs.status)
        draftSave.dismiss()
        setTimeout(() => setDirty(), 0)
    }

    // Publish answered 409: the open editor is "mine" for the review screen.
    const reviewPublishConflict = (found) => {
        if (!chatflow?.id || !reactFlowInstance) return
        // Save anyway from the review screen keeps the flow's name.
        pendingSaveNameRef.current = chatflow.name || ''
        draftSave.openConflict(chatflow.id, found, JSON.stringify(canvasSaveDocument(reactFlowInstance, { workflow: true })))
    }

    const queueStarterQuestions = (savedFlow, questions, saveRev, finish) => {
        if (!questions.length) {
            finish(savedFlow)
            return
        }
        const continuation = starterQuestionsSaveEntry({
            savedFlow,
            questions,
            rev: saveRev,
            save: chatflowsApi.updateChatflow,
            isCurrent: () => builderStartersRef.current === questions,
            clear: () => {
                builderStartersRef.current = []
            },
            onAck: (saved) => {
                dispatch({ type: SET_CHATFLOW, chatflow: saved })
            },
            onSettled: (saved) => finish(saved),
            onError: (error) => errorFailed(saveFailureMessage(error, 'Saving the starter questions failed'))
        })
        if (!continuation) {
            if (builderStartersRef.current === questions) builderStartersRef.current = []
            finish(savedFlow)
            return
        }
        draftSave.runNonReplay(continuation, { internal: true })
    }

    const queueLiveSave = (
        body,
        saveRev,
        baseUpdatedDate,
        starterQuestions = [],
        internal = false,
        flowId = chatflow.id,
        flowName = chatflow.name
    ) => {
        const isStartingRoute = () => Boolean(liveSavePreflightForRoute({ flowId }, routeFlowIdRef.current))
        draftSave.saveLive(
            {
                id: flowId,
                rev: saveRev,
                body,
                baseUpdatedDate,
                onAck: (saved) => {
                    if (!isStartingRoute()) return
                    dispatch({ type: SET_CHATFLOW, chatflow: saved })
                    queueStarterQuestions(saved, starterQuestions, saveRev, () => saveChatflowSuccess(undefined, saveRev))
                },
                onChanged: async (stored) => {
                    if (!isStartingRoute()) return
                    const isConfirmed = await confirm({
                        title: `Confirm Change`,
                        description: `${canvasTitle} ${flowName} has changed since you have opened, overwrite changes?`,
                        confirmButtonName: 'Confirm',
                        cancelButtonName: 'Cancel'
                    })
                    if (isConfirmed && isStartingRoute())
                        queueLiveSave(body, saveRev, stored?.updatedDate, starterQuestions, true, flowId, flowName)
                },
                onError: (error) => {
                    if (isStartingRoute()) errorFailed(`Failed to save ${canvasTitle}: ${requestFailureMessage(error)}`)
                }
            },
            { internal }
        )
    }

    const handleSaveFlowName = (name, callbacks = {}) => {
        draftSave.runNonReplay(
            {
                id: chatflow.id,
                send: () => chatflowsApi.updateChatflow(chatflow.id, { name }),
                onAck: callbacks.onAck,
                onError: callbacks.onError
            },
            { internal: true }
        )
    }

    const createdLiveEntry = (created, body, saveRev, baseUpdatedDate, starterQuestions = []) => ({
        kind: 'live',
        id: created.id,
        rev: saveRev,
        body,
        baseUpdatedDate,
        onAck: (saved) => {
            dispatch({ type: SET_CHATFLOW, chatflow: saved })
            queueStarterQuestions(saved, starterQuestions, saveRev, () => saveChatflowSuccess(undefined, saveRev))
        },
        onChanged: async (stored) => {
            const isConfirmed = await confirm({
                title: `Confirm Change`,
                description: `${canvasTitle} ${created.name} has changed since you have opened, overwrite changes?`,
                confirmButtonName: 'Confirm',
                cancelButtonName: 'Cancel'
            })
            if (isConfirmed)
                draftSave.saveLive(createdLiveEntry(created, body, saveRev, stored?.updatedDate, starterQuestions), { internal: true })
        },
        onError: (error) => errorFailed(`Failed to save ${canvasTitle}: ${requestFailureMessage(error)}`)
    })

    const createdSnapshotEntry = (created, status, { flowData, name, saveRev, starterQuestions = [] }) => {
        const plan = planCanvasSave({ mode: status?.mode, name, savedName: created.name, flowData, hasId: true })
        if (plan.draft) {
            return {
                kind: 'draft',
                id: created.id,
                rev: saveRev,
                flowData: plan.draft.flowData,
                liveFlowData: created.flowData,
                name,
                onAck: (savedStatus, details) => {
                    setDraftStatus(savedStatus)
                    if (details.hasBase64 && canvasRef.current.editRev === saveRev && details.storedFlowData !== plan.draft.flowData) {
                        try {
                            const stored = readGraph(details.storedFlowData)
                            setNodes(stored.nodes || [])
                            setEdges(stored.edges || [])
                        } catch {
                            // The stored canvas is still the saved result when it cannot be painted.
                        }
                    }
                    const finish = () => saveChatflowSuccess('Draft saved', saveRev)
                    if (!plan.live?.name) {
                        queueStarterQuestions(created, starterQuestions, saveRev, finish)
                        return
                    }
                    draftSave.runNonReplay(
                        {
                            id: created.id,
                            send: () => chatflowsApi.updateChatflow(created.id, { name: plan.live.name }),
                            onAck: (saved) => {
                                dispatch({ type: SET_CHATFLOW, chatflow: saved })
                                queueStarterQuestions(saved, starterQuestions, saveRev, finish)
                            },
                            onError: (error) => errorFailed(saveFailureMessage(error))
                        },
                        { internal: true }
                    )
                },
                onError: (error) => errorFailed(saveFailureMessage(error))
            }
        }
        return createdLiveEntry(
            created,
            { name: plan.live.name, flowData: plan.live.flowData },
            saveRev,
            created.updatedDate,
            starterQuestions
        )
    }

    const handleSaveFlow = async (chatflowName, saveOptions) => {
        if (canvasBlocked) {
            errorFailed('Draft status is still unknown. Retry loading before you save.')
            return
        }
        const saveRev = canvas.editRev
        if (typeof chatflowName === 'string') pendingSaveNameRef.current = chatflowName
        if (reactFlowInstance) {
            const rfInstanceObject = canvasSaveDocument(reactFlowInstance, { workflow: true })
            const flowData = JSON.stringify(rfInstanceObject)
            const starterQuestions = builderStartersRef.current

            if (!chatflow.id) {
                const newChatflowBody = {
                    ...(duplicateSourceId ? { duplicateSourceId } : {}),
                    name: chatflowName,
                    deployed: false,
                    isPublic: false,
                    flowData,
                    type: 'AGENTFLOW'
                }
                const chatbotConfig = withStarterQuestions(undefined, builderStartersRef.current)
                if (chatbotConfig) newChatflowBody.chatbotConfig = chatbotConfig
                draftSave.saveCreate({
                    send: () => chatflowsApi.createNewChatflow(newChatflowBody),
                    onAck: (created, details) =>
                        createdChatflowSuccess(created, {
                            saveRev,
                            starterQuestions,
                            willContinue: details?.willContinue === true
                        }),
                    onStatus: (status, created) => {
                        setDraftStatus(status)
                        setDraftStatusLoad({ flowId: created.id, known: true, loading: false, error: null })
                    },
                    afterCreate: (created, status, details) =>
                        details.fromPending
                            ? createdSnapshotEntry(created, status, { flowData, name: chatflowName, saveRev, starterQuestions })
                            : null,
                    onError: (error) => errorFailed(`Failed to save ${canvasTitle}: ${requestFailureMessage(error)}`)
                })
            } else {
                const plan = planCanvasSave({
                    mode: draftStatusRef.current?.mode,
                    name: chatflowName,
                    savedName: chatflow.name,
                    flowData,
                    hasId: true
                })
                if (plan.modeUnknown) {
                    errorFailed('Draft status is still unknown. Retry loading before you save.')
                    return
                }
                if (plan.draft) {
                    draftSave.saveDraft({
                        id: chatflow.id,
                        rev: saveRev,
                        flowData: plan.draft.flowData,
                        liveFlowData: chatflow.flowData,
                        name: chatflowName,
                        overwriteDraftChanges: saveOptions?.overwriteDraftChanges === true,
                        onAck: (status, details) => {
                            setDraftStatus(status)
                            if (
                                details.hasBase64 &&
                                canvasRef.current.editRev === saveRev &&
                                details.storedFlowData !== plan.draft.flowData
                            ) {
                                try {
                                    const stored = readGraph(details.storedFlowData)
                                    setNodes(stored.nodes || [])
                                    setEdges(stored.edges || [])
                                } catch {
                                    // The saved response remains authoritative even when it cannot be painted.
                                }
                            }
                            const finish = () => saveChatflowSuccess('Draft saved', saveRev)
                            if (!plan.live?.name) {
                                queueStarterQuestions(chatflow, starterQuestions, saveRev, finish)
                                return
                            }
                            draftSave.runNonReplay(
                                {
                                    id: chatflow.id,
                                    send: () => chatflowsApi.updateChatflow(chatflow.id, { name: plan.live.name }),
                                    onAck: (saved) => {
                                        dispatch({ type: SET_CHATFLOW, chatflow: saved })
                                        queueStarterQuestions(saved, starterQuestions, saveRev, finish)
                                    },
                                    onError: (error) => errorFailed(saveFailureMessage(error))
                                },
                                { internal: true }
                            )
                        },
                        onError: (error) => errorFailed(saveFailureMessage(error))
                    })
                    return
                }
                if (plan.live?.flowData) {
                    queueLiveSave({ name: plan.live.name, flowData: plan.live.flowData }, saveRev, chatflow.updatedDate, starterQuestions)
                    return
                }
                if (plan.live?.name) {
                    draftSave.runNonReplay({
                        id: chatflow.id,
                        send: () => chatflowsApi.updateChatflow(chatflow.id, { name: plan.live.name }),
                        onAck: (saved) => {
                            dispatch({ type: SET_CHATFLOW, chatflow: saved })
                            saveChatflowSuccess(undefined, saveRev)
                        },
                        onError: (error) => errorFailed(saveFailureMessage(error))
                    })
                    return
                }
            }
        }
    }

    // eslint-disable-next-line
    const onNodeClick = useCallback((event, clickedNode) => {
        setSelectedNode(clickedNode)
        if (clickedNode?.data && clickedNode.data.name !== 'stickyNoteAgentflow') {
            if (clickedNode.id !== panelNodeId) {
                setPanelProps({
                    data: clickedNode.data,
                    inputParams: clickedNode.data.inputParams.filter((inputParam) => !inputParam.hidden)
                })
            }
            setPanelNodeId(clickedNode.id)
        } else {
            setPanelNodeId(null)
        }
        setNodes((nds) =>
            nds.map((node) => {
                if (node.id === clickedNode.id) {
                    node.data = {
                        ...node.data,
                        selected: true
                    }
                } else {
                    node.data = {
                        ...node.data,
                        selected: false
                    }
                }

                return node
            })
        )
    })

    // eslint-disable-next-line
    const onNodeDoubleClick = useCallback((event, node) => {
        if (!node || !node.data) return
        if (node.data.name === 'stickyNoteAgentflow') {
            // dont show dialog
        } else if (newLook) {
            // The click already opened the side panel.
        } else {
            const dialogProps = {
                data: node.data,
                inputParams: node.data.inputParams.filter((inputParam) => !inputParam.hidden)
            }

            setEditNodeDialogProps(dialogProps)
            setEditNodeDialogOpen(true)
        }
    })

    const onDragOver = useCallback((event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
    }, [])

    const onDrop = useCallback(
        (event) => {
            event.preventDefault()
            const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect()
            let nodeData = event.dataTransfer.getData('application/reactflow')

            // check if the dropped element is valid
            if (typeof nodeData === 'undefined' || !nodeData) {
                return
            }

            nodeData = JSON.parse(nodeData)

            const position = reactFlowInstance.project({
                x: event.clientX - reactFlowBounds.left - 100,
                y: event.clientY - reactFlowBounds.top - 50
            })
            const nodes = reactFlowInstance.getNodes()

            if (nodeData.name === 'startAgentflow' && nodes.find((node) => node.data.name === 'startAgentflow')) {
                enqueueSnackbar({
                    message: 'Only one start node is allowed',
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'error',
                        persist: true,
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
                return
            }

            const newNodeId = getUniqueNodeId(nodeData, reactFlowInstance.getNodes())
            const newNodeLabel = getUniqueNodeLabel(nodeData, nodes)

            const newNode = {
                id: newNodeId,
                position,
                data: { ...initNode(nodeData, newNodeId, true), label: newNodeLabel }
            }

            if (nodeData.type === 'Iteration') {
                newNode.type = 'iteration'
            } else if (nodeData.type === 'StickyNote') {
                newNode.type = 'stickyNote'
            } else {
                newNode.type = 'agentFlow'
            }

            // Check if the dropped node is within any Iteration node's flowContainerSize
            const iterationNodes = nodes.filter((node) => node.type === 'iteration')
            let parentNode = null

            for (const iterationNode of iterationNodes) {
                // Get the iteration node's position and dimensions
                const nodeWidth = iterationNode.width || 300
                const nodeHeight = iterationNode.height || 250

                // Calculate the boundaries of the iteration node
                const nodeLeft = iterationNode.position.x
                const nodeRight = nodeLeft + nodeWidth
                const nodeTop = iterationNode.position.y
                const nodeBottom = nodeTop + nodeHeight

                // Check if the dropped position is within these boundaries
                if (position.x >= nodeLeft && position.x <= nodeRight && position.y >= nodeTop && position.y <= nodeBottom) {
                    parentNode = iterationNode

                    // We can't have nested iteration nodes
                    if (nodeData.name === 'iterationAgentflow') {
                        enqueueSnackbar({
                            message: 'Nested iteration node is not supported yet',
                            options: {
                                key: new Date().getTime() + Math.random(),
                                variant: 'error',
                                persist: true,
                                action: (key) => (
                                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                        <IconX />
                                    </Button>
                                )
                            }
                        })
                        return
                    }

                    // We can't have human input node inside iteration node
                    if (nodeData.name === 'humanInputAgentflow') {
                        enqueueSnackbar({
                            message: 'Human input node is not supported inside Iteration node',
                            options: {
                                key: new Date().getTime() + Math.random(),
                                variant: 'error',
                                persist: true,
                                action: (key) => (
                                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                        <IconX />
                                    </Button>
                                )
                            }
                        })
                        return
                    }
                    break
                }
            }

            // If the node is dropped inside an iteration node, set its parent
            if (parentNode) {
                newNode.parentNode = parentNode.id
                newNode.extent = 'parent'
                // Adjust position to be relative to the parent
                newNode.position = {
                    x: position.x - parentNode.position.x,
                    y: position.y - parentNode.position.y
                }
            }

            setSelectedNode(newNode)
            setNodes((nds) => {
                return (nds ?? []).concat(newNode).map((node) => {
                    if (node.id === newNode.id) {
                        node.data = {
                            ...node.data,
                            selected: true
                        }
                    } else {
                        node.data = {
                            ...node.data,
                            selected: false
                        }
                    }

                    return node
                })
            })
            setTimeout(() => setDirty(), 0)
        },

        // eslint-disable-next-line
        [reactFlowInstance]
    )

    const syncNodes = () => {
        const componentNodes = canvas.componentNodes

        const cloneNodes = cloneDeep(nodes)
        const cloneEdges = cloneDeep(edges)
        let toBeRemovedEdges = []

        for (let i = 0; i < cloneNodes.length; i++) {
            const node = cloneNodes[i]
            const componentNode = componentNodes.find((cn) => cn.name === node.data.name)
            if (needsSync(node, componentNode)) {
                const clonedComponentNode = cloneDeep(componentNode)
                cloneNodes[i].data = updateOutdatedNodeData(clonedComponentNode, node.data, true)
                toBeRemovedEdges.push(...updateOutdatedNodeEdge(cloneNodes[i].data, cloneEdges))
            }
        }

        setNodes(cloneNodes)
        setEdges(cloneEdges.filter((edge) => !toBeRemovedEdges.includes(edge)))
        setDirty()
        setIsSyncNodesButtonEnabled(false)
    }

    const { reward: confettiReward } = useReward('canvasConfetti', 'confetti', {
        elementCount: 150,
        spread: 80,
        lifetime: 300,
        startVelocity: 40,
        zIndex: 10000,
        decay: 0.92,
        position: 'fixed'
    })

    const builtMessage = (result, replaced) => {
        const missing = missingCredentialsText(result.missingCredentials)
        const name = result.title ? `"${result.title}"` : 'The workflow'
        return `${name} is on the canvas${replaced ? ' in place of the old cards' : ''}. Save to keep it.${missing ? ` ${missing}` : ''}`
    }

    const placeBuilt = (result, replaced) => {
        const previous = replaced ? { nodes: reactFlowInstance.getNodes(), edges: reactFlowInstance.getEdges() } : null
        const previousStarters = builderStartersRef.current
        reactFlowInstance.setNodes(result.nodes)
        reactFlowInstance.setEdges(result.edges)
        builderStartersRef.current = result.starterQuestions || []
        setTimeout(() => {
            setDirty()
            reactFlowInstance.fitView({ padding: 0.2 })
        }, 0)
        triggerConfetti()
        enqueueSnackbar({
            message: builtMessage(result, replaced),
            options: {
                key: new Date().getTime() + Math.random(),
                variant: result.missingCredentials?.length ? 'warning' : 'success',
                persist: Boolean(previous || result.missingCredentials?.length),
                action: (key) => (
                    <>
                        {previous && (
                            <Button
                                style={{ color: 'white' }}
                                onClick={() => {
                                    reactFlowInstance.setNodes(previous.nodes)
                                    reactFlowInstance.setEdges(previous.edges)
                                    builderStartersRef.current = previousStarters
                                    closeSnackbar(key)
                                }}
                            >
                                Undo
                            </Button>
                        )}
                        <Button style={{ color: 'white' }} aria-label='Close' onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    </>
                )
            }
        })
    }

    const onBuilt = (result) => {
        if (canvasIsEmpty(reactFlowInstance.getNodes(), reactFlowInstance.getEdges())) placeBuilt(result, false)
        else setBuiltResult(result)
    }

    const startNewBuilt = () => {
        stashNewCanvas(builtResult)
        setBuiltResult(null)
        window.open(`${uiBaseURL}/v2/agentcanvas`, '_blank')
    }

    const replaceWithBuilt = () => {
        const result = builtResult
        setBuiltResult(null)
        placeBuilt(result, true)
    }

    const triggerConfetti = () => {
        setTimeout(() => {
            confettiReward()
        }, 50)
    }

    const saveChatflowSuccess = (message = `${canvasTitle} saved`, rev) => {
        dispatch({ type: REMOVE_DIRTY, rev })
        enqueueSnackbar({
            message,
            options: {
                key: new Date().getTime() + Math.random(),
                variant: 'success',
                action: (key) => (
                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                        <IconX />
                    </Button>
                )
            }
        })
    }

    const errorFailed = (message) => {
        enqueueSnackbar({
            message,
            options: {
                key: new Date().getTime() + Math.random(),
                variant: 'error',
                persist: true,
                action: (key) => (
                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                        <IconX />
                    </Button>
                )
            }
        })
    }

    const setDirty = () => {
        dispatch({ type: SET_DIRTY })
    }

    // ==============================|| useEffect ||============================== //

    const readGraph = (text) => {
        if (!text) return { nodes: [], edges: [] }
        const parsed = JSON.parse(text)
        return { nodes: parsed.nodes || [], edges: parsed.edges || [] }
    }

    const applyCanvasText = (text) => {
        // Blank or unreadable text used to become an empty graph and could replace the published canvas.
        if (!canvasTextToApply(text)) return
        try {
            const flow = readGraph(text)
            if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) return
            setNodes(flow.nodes)
            setEdges(flow.edges)
        } catch {
            return
        }
        closeCardEditors()
        dispatch({ type: REMOVE_DIRTY })
        // Discard, Publish and rollback replace the canvas with a saved one, and set the new draft status first.
        // The next save and the review screen build on that canvas, not on the draft that was open before.
        draftSave.record(draftStatusRef.current, text)
    }

    // Get specific chatflow successful
    useEffect(() => {
        const flowLoad = flowLoadAction(chatflowId, requestedFlowIdRef.current, getSpecificChatflowApi.data, getSpecificChatflowApi.error)
        if (flowLoad === 'paint') {
            const loaded = getSpecificChatflowApi.data
            let cancelled = false
            setDraftStatus(null)
            setDraftStatusLoad((previous) => ({
                flowId: loaded.id,
                known: false,
                loading: true,
                error: null,
                request: 'status',
                retrying: previous.flowId === loaded.id && Boolean(previous.retrying || previous.error)
            }))
            const paint = (status) => {
                if (cancelled) return
                setDraftStatusLoad({ flowId: loaded.id, known: true, loading: false, error: null })
                setDraftStatus(status)
                const text = canvasFlowText(loaded, status)
                draftSave.record(status, text)
                try {
                    const initialFlow = readGraph(text)
                    setNodes(initialFlow.nodes)
                    setEdges(initialFlow.edges)
                } catch {
                    try {
                        const fallback = readGraph(loaded.flowData)
                        setNodes(fallback.nodes)
                        setEdges(fallback.edges)
                    } catch {
                        setNodes([])
                        setEdges([])
                    }
                }
                dispatch({ type: SET_CHATFLOW, chatflow: loaded })
                dispatch({ type: REMOVE_DIRTY })
            }
            const signal = openRequest.signalFor(loaded.id)
            flowDraftsApi
                .getStatus(loaded.id, { signal })
                .then((res) => {
                    const decision = draftStatusOpenDecision(res)
                    if (decision.paint) paint(decision.status)
                })
                .catch((error) => {
                    const decision = draftStatusOpenDecision(undefined, error)
                    if (!cancelled && !decision.paint) {
                        setDraftStatusLoad({ flowId: loaded.id, known: false, loading: false, error: decision.error, request: 'status' })
                    }
                })
            return () => {
                cancelled = true
                openRequest.abort(loaded.id)
            }
        } else if (flowLoad === 'fail') {
            setDraftStatusLoad({
                flowId: chatflowId,
                known: false,
                loading: false,
                error: getSpecificChatflowApi.error,
                request: 'flow'
            })
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getSpecificChatflowApi.data, getSpecificChatflowApi.error, draftStatusRetry])

    const retryDraftStatusLoad = () => {
        setDraftStatus(null)
        setDraftStatusLoad({
            flowId: routeFlowId,
            known: false,
            loading: true,
            error: null,
            retrying: true,
            request: draftStatusLoad.request
        })
        if (canvasLoadRetryRequest(chatflowId, draftStatusLoad, getSpecificChatflowApi.data?.id) === 'flow') {
            requestFlow(chatflowId)
        } else {
            setDraftStatusRetry((attempt) => attempt + 1)
        }
    }

    function createdChatflowSuccess(created, { saveRev, starterQuestions, willContinue }) {
        builderStartersRef.current = starterQuestionsAfterCreate({
            current: builderStartersRef.current,
            captured: starterQuestions,
            willContinue
        })
        dispatch({ type: SET_CHATFLOW, chatflow: created })
        if (!willContinue) saveChatflowSuccess(created.accessNotice, saveRev)
        createdFlowIdRef.current = created.id
        window.history.replaceState(state, null, `/v2/agentcanvas/${created.id}`)
    }

    useEffect(() => {
        setChatflow(canvasDataStore.chatflow)

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasDataStore.chatflow])

    useEffect(() => {
        setIsSyncNodesButtonEnabled(anyNeedsSync(nodes, canvas.componentNodes))
    }, [nodes, canvas.componentNodes])

    // Initialization
    useEffect(() => {
        setIsSyncNodesButtonEnabled(false)
        if (!chatflowId) {
            let importedName = ''
            const storedFlow = localStorage.getItem('duplicatedFlowData')
            if (storedFlow) {
                try {
                    const stored = JSON.parse(storedFlow)
                    if (stored.cuttlelyDuplicateSourceId) {
                        setDuplicateSourceId(stored.cuttlelyDuplicateSourceId)
                        enqueueSnackbar({
                            message:
                                'This copy will start Private. Access-key grants are not copied. Pick or create a key for the copy in API Endpoint.',
                            options: { key: 'duplicate-access', variant: 'warning', persist: true }
                        })
                    }
                    if (stored && stored.cuttlelyMigration && typeof stored.name === 'string' && stored.name.trim()) {
                        importedName = stored.name.trim()
                    }
                } catch {
                    importedName = ''
                }
                handleLoadFlow(storedFlow)
                setTimeout(() => localStorage.removeItem('duplicatedFlowData'), 0)
                const landing = takeLanding()
                if (landing) {
                    builderStartersRef.current = landing.starterQuestions
                    const missing = missingCredentialsText(landing.missingCredentials)
                    if (missing)
                        enqueueSnackbar({
                            message: missing,
                            options: {
                                key: new Date().getTime() + Math.random(),
                                variant: 'warning',
                                persist: true,
                                action: (key) => (
                                    <Button style={{ color: 'white' }} aria-label='Close' onClick={() => closeSnackbar(key)}>
                                        <IconX />
                                    </Button>
                                )
                            }
                        })
                }
            } else {
                setNodes([])
                setEdges([])
            }
            dispatch({
                type: SET_CHATFLOW,
                chatflow: {
                    name: importedName || `Untitled ${canvasTitle}`
                }
            })
        }

        getNodesApi.request()

        // Clear dirty state before leaving and remove any ongoing test triggers and webhooks
        return () => {
            setTimeout(() => dispatch({ type: REMOVE_DIRTY }), 0)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        // A flow created on this canvas already has its cards and draft status; reloading it would replace newer edits.
        const action = createdFlowRouteAction(createdFlowIdRef.current, chatflowId)
        if (action !== 'load') return
        // The exemption belongs only to the create-time address change. Once the route leaves that flow, returning
        // to it must issue a normal saved-flow request instead of reusing another flow's load state.
        createdFlowIdRef.current = null
        setDraftStatus(null)
        setDraftStatusLoad({ flowId: chatflowId, known: false, loading: true, error: null, request: 'flow' })
        requestFlow(chatflowId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [chatflowId])

    // Back, unmount, or a route change stops the saved-flow/status retry owned by the route being left.
    useEffect(() => () => abortOpenRequest(chatflowId), [abortOpenRequest, chatflowId])

    useEffect(() => {
        setCanvasDataStore(canvas)
    }, [canvas])

    useEffect(() => {
        function handlePaste(e) {
            if (canvasBlocked) return
            const pasteData = e.clipboardData.getData('text')
            //TODO: prevent paste event when input focused, temporary fix: catch chatflow syntax
            if (pasteData.includes('{"nodes":[') && pasteData.includes('],"edges":[')) {
                handleLoadFlow(pasteData)
            }
        }

        window.addEventListener('paste', handlePaste)

        return () => {
            window.removeEventListener('paste', handlePaste)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasBlocked])

    useEffect(() => {
        if (templateFlowData && templateFlowData.includes('"nodes":[') && templateFlowData.includes('],"edges":[')) {
            const settingsNote = templateSettingsMessage(templateFlowData)
            handleLoadFlow(templateFlowData)
            if (settingsNote)
                enqueueSnackbar({
                    message: settingsNote,
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'info',
                        persist: true,
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [templateFlowData])

    usePrompt('You have unsaved changes! Do you want to navigate away?', canvasDataStore.isDirty)

    const [chatPopupOpen, setChatPopupOpen] = useState(false)

    useEffect(() => {
        if (!chatflowId && !localStorage.getItem('duplicatedFlowData') && getNodesApi.data && nodes.length === 0) {
            const startNodeData = getNodesApi.data.find((node) => node.name === 'startAgentflow')
            if (startNodeData) {
                const clonedStartNodeData = cloneDeep(startNodeData)
                clonedStartNodeData.position = { x: 100, y: 100 }
                const startNode = {
                    id: 'startAgentflow_0',
                    type: 'agentFlow',
                    position: { x: 100, y: 100 },
                    data: {
                        ...initNode(clonedStartNodeData, 'startAgentflow_0', true),
                        label: 'Start'
                    }
                }
                setNodes([startNode])
                setEdges([])
            }
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getNodesApi.data, chatflowId])

    // The panel closes when its card is deleted or the switch turns the new look off.
    const openPanel = panelNode(nodes, newLook ? panelNodeId : null)
    const panelOpen = Boolean(openPanel)
    const panelOpenRef = useRef(false)
    panelOpenRef.current = panelOpen
    // Duplicating while the panel is open selects the copy and moves the panel onto it.
    const onDuplicated = useCallback((created) => {
        const newId = created?.id
        if (!newId || !panelOpenRef.current) return
        setPanelNodeId(newId)
        if (!created.data) return
        setPanelProps({
            data: created.data,
            inputParams: (created.data.inputParams || []).filter((inputParam) => !inputParam.hidden)
        })
    }, [])
    const panelContext = useMemo(
        () => ({ panelNodeId: panelOpen ? panelNodeId : null, compact: false, onDuplicated }),
        [panelNodeId, panelOpen, onDuplicated]
    )
    // A deleted card must not leave its id or its saved settings open for the next card that reuses the id.
    useEffect(() => {
        const next = panelStateWhenNodesChange({ panelNodeId, panelProps, nodes })
        if (next.panelNodeId !== panelNodeId) {
            setPanelNodeId(null)
            setPanelProps({})
        }
    }, [nodes, panelNodeId, panelProps])

    return (
        <CanvasLoadGuard
            flowId={routeFlowId}
            loadState={draftStatusLoad}
            onRetry={retryDraftStatusLoad}
            onBack={() => navigate('/agentflows')}
        >
            <>
                <span
                    id='canvasConfetti'
                    style={{
                        position: 'fixed',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)',
                        width: '0',
                        height: '0',
                        zIndex: 9999,
                        pointerEvents: 'none',
                        background: 'transparent'
                    }}
                />

                <Box>
                    <AppBar
                        enableColorOnDark
                        position='fixed'
                        color='inherit'
                        elevation={1}
                        sx={{
                            bgcolor: theme.palette.background.default
                        }}
                    >
                        <Toolbar sx={{ height: 'auto', alignItems: 'center', py: { xs: 1, md: 0 } }}>
                            <CanvasHeader
                                chatflow={chatflow}
                                handleSaveFlow={handleSaveFlow}
                                handleSaveFlowName={handleSaveFlowName}
                                handleDeleteFlow={handleDeleteFlow}
                                handleLoadFlow={handleLoadFlow}
                                onApplyMigration={({ canvas, name }) => {
                                    setNodes(canvas?.nodes || [])
                                    setEdges(canvas?.edges || [])
                                    setTimeout(() => setDirty(), 0)
                                    if (!chatflow?.id && name) {
                                        dispatch({ type: SET_CHATFLOW, chatflow: { name } })
                                    }
                                }}
                                isAgentCanvas={true}
                                isAgentflowV2={true}
                                draftStatus={draftStatus}
                                onDraftStatus={setDraftStatus}
                                onChatflowUpdated={(next) => dispatch({ type: SET_CHATFLOW, chatflow: next })}
                                onApplyCanvas={applyCanvasText}
                                onFlowCreated={(created) => {
                                    adoptImportedIdentity({
                                        created,
                                        flowType: 'AGENTFLOW',
                                        agentV2: true,
                                        remember: (id) => {
                                            createdFlowIdRef.current = id
                                        },
                                        replaceState: (...args) => window.history.replaceState(...args),
                                        historyState: state
                                    })
                                    dispatch({ type: SET_CHATFLOW, chatflow: created })
                                    setDraftStatusLoad({ flowId: created.id, known: true, loading: false, error: null, request: 'status' })
                                }}
                                onDraftUnavailable={() => {
                                    const next = draftStatusWhenImportUnknown(routeFlowId || createdFlowIdRef.current)
                                    setDraftStatus(next.status)
                                    setDraftStatusLoad(next.load)
                                }}
                                onDirty={setDirty}
                                draftExpected={draftSave.expected}
                                onDraftConflict={reviewPublishConflict}
                                saveQueueBusy={draftSave.busy}
                            />
                        </Toolbar>
                    </AppBar>
                    <Box sx={{ pt: { xs: '120px', md: '70px' }, height: '100vh', width: '100%' }}>
                        <ReactFlowProvider>
                            <CanvasPanelContext.Provider value={panelContext}>
                                <div className='reactflow-parent-wrapper'>
                                    <div className='reactflow-wrapper' ref={reactFlowWrapper} style={{ position: 'relative' }}>
                                        <ReactFlow
                                            nodes={nodes}
                                            edges={edges}
                                            onNodesChange={handleNodesChange}
                                            onNodeClick={onNodeClick}
                                            onNodeDoubleClick={onNodeDoubleClick}
                                            onPaneClick={() => setPanelNodeId(null)}
                                            onEdgesChange={handleEdgesChange}
                                            onDrop={onDrop}
                                            onDragOver={onDragOver}
                                            onNodeDragStop={setDirty}
                                            nodeTypes={nodeTypes}
                                            edgeTypes={edgeTypes}
                                            onConnect={onConnect}
                                            onInit={setReactFlowInstance}
                                            fitView
                                            deleteKeyCode={canvasBlocked || canvas.canvasDialogShow ? null : ['Delete', 'Backspace']}
                                            minZoom={0.5}
                                            snapGrid={[25, 25]}
                                            snapToGrid={isSnappingEnabled}
                                            connectionLineComponent={ConnectionLine}
                                        >
                                            <Controls
                                                className={customization.isDarkMode ? 'dark-mode-controls' : ''}
                                                style={{
                                                    display: 'flex',
                                                    flexDirection: 'row',
                                                    left: '50%',
                                                    transform: 'translate(-50%, -50%)'
                                                }}
                                            >
                                                <button
                                                    className='react-flow__controls-button react-flow__controls-interactive'
                                                    onClick={() => {
                                                        setIsSnappingEnabled(!isSnappingEnabled)
                                                    }}
                                                    title='toggle snapping'
                                                    aria-label='toggle snapping'
                                                >
                                                    {isSnappingEnabled ? <IconMagnetFilled /> : <IconMagnetOff />}
                                                </button>
                                                <button
                                                    className='react-flow__controls-button react-flow__controls-interactive'
                                                    onClick={() => {
                                                        setIsBackgroundEnabled(!isBackgroundEnabled)
                                                    }}
                                                    title='toggle background'
                                                    aria-label='toggle background'
                                                >
                                                    {isBackgroundEnabled ? <IconArtboard /> : <IconArtboardOff />}
                                                </button>
                                                <button
                                                    className='react-flow__controls-button react-flow__controls-interactive'
                                                    onClick={() => setCanvasLook(newLook ? 'classic' : 'panel')}
                                                    title={
                                                        newLook
                                                            ? 'New look (settings in a side panel): on'
                                                            : 'New look (settings in a side panel): off'
                                                    }
                                                    aria-label='toggle side panel'
                                                    aria-pressed={newLook}
                                                >
                                                    {newLook ? <IconLayoutSidebarRightFilled /> : <IconLayoutSidebarRight />}
                                                </button>
                                            </Controls>
                                            <MiniMap
                                                nodeStrokeWidth={3}
                                                nodeColor={customization.isDarkMode ? '#2d2d2d' : '#e2e2e2'}
                                                nodeStrokeColor={customization.isDarkMode ? '#525252' : '#fff'}
                                                maskColor={customization.isDarkMode ? 'rgb(45, 45, 45, 0.6)' : 'rgb(240, 240, 240, 0.6)'}
                                                style={{
                                                    backgroundColor: customization.isDarkMode ? theme.palette.background.default : '#fff'
                                                }}
                                            />
                                            {isBackgroundEnabled && <Background color='#aaa' gap={16} />}
                                            <AddNodes
                                                isAgentCanvas={true}
                                                isAgentflowv2={true}
                                                nodesData={getNodesApi.data}
                                                node={selectedNode}
                                                buildKind='workflow'
                                                onBuilt={onBuilt}
                                            />
                                            <BuildLandingDialog
                                                show={Boolean(builtResult)}
                                                title={builtResult?.title}
                                                onStartNew={startNewBuilt}
                                                onReplace={replaceWithBuilt}
                                                onCancel={() => setBuiltResult(null)}
                                            />
                                            <EditNodeDialog
                                                show={editNodeDialogOpen}
                                                dialogProps={editNodeDialogProps}
                                                onCancel={() => setEditNodeDialogOpen(false)}
                                            />
                                            {isSyncNodesButtonEnabled && (
                                                <Fab
                                                    sx={{
                                                        left: 60,
                                                        top: 20,
                                                        color: 'white',
                                                        background: 'orange',
                                                        '&:hover': {
                                                            background: 'orange',
                                                            backgroundImage: `linear-gradient(rgb(0 0 0/10%) 0 0)`
                                                        }
                                                    }}
                                                    size='small'
                                                    aria-label='sync'
                                                    title='Sync Nodes'
                                                    onClick={() => syncNodes()}
                                                >
                                                    <IconRefreshAlert />
                                                </Fab>
                                            )}
                                            {isScheduleFlow ? (
                                                <ScheduleHistoryFAB chatflowid={chatflowId} onOpenChange={setChatPopupOpen} />
                                            ) : isWebhookFlow ? (
                                                <WebhookListenerFAB chatflowid={chatflowId} onOpenChange={setChatPopupOpen} />
                                            ) : (
                                                <ChatPopUp isAgentCanvas={true} chatflowid={chatflowId} onOpenChange={setChatPopupOpen} />
                                            )}
                                            {!chatPopupOpen && <ValidationPopUp isAgentCanvas={true} chatflowid={chatflowId} />}
                                        </ReactFlow>
                                    </div>
                                    {panelOpen && (
                                        <EditNodeDialog
                                            variant='panel'
                                            show={true}
                                            dialogProps={panelProps}
                                            onCancel={() => setPanelNodeId(null)}
                                        />
                                    )}
                                </div>
                            </CanvasPanelContext.Provider>
                        </ReactFlowProvider>
                    </Box>
                    <ConfirmDialog />
                    <DraftConflictDialog
                        open={Boolean(draftSave.conflict)}
                        conflict={draftSave.conflict}
                        onReload={reloadSharedDraft}
                        onSaveAnyway={() => {
                            draftSave.dismiss()
                            handleSaveFlow(pendingSaveNameRef.current, { overwriteDraftChanges: true })
                        }}
                        onApply={applyMergedDraft}
                        onClose={draftSave.dismiss}
                    />
                </Box>
            </>
        </CanvasLoadGuard>
    )
}

export default AgentflowCanvas
