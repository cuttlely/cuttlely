import { useEffect, useMemo, useRef, useState, useCallback, useContext } from 'react'
import ReactFlow, { addEdge, Controls, Background, ReactFlowProvider, useNodesState, useEdgesState } from 'reactflow'
import 'reactflow/dist/style.css'

import { useDispatch, useSelector } from 'react-redux'
import { useNavigate, useLocation } from 'react-router-dom'
import {
    REMOVE_DIRTY,
    SET_DIRTY,
    SET_CHATFLOW,
    SET_NODE_PACK_INDEX,
    enqueueSnackbar as enqueueSnackbarAction,
    closeSnackbar as closeSnackbarAction
} from '@/store/actions'
import { omit, cloneDeep } from 'lodash'

// material-ui
import { Toolbar, Box, AppBar, Button, Fab } from '@mui/material'
import { useTheme } from '@mui/material/styles'

// project imports
import CanvasNode from './CanvasNode'
import ButtonEdge from './ButtonEdge'
import StickyNote from './StickyNote'
import CanvasHeader from './CanvasHeader'
import AddNodes from './AddNodes'
import NodeSidePanel from './NodeSidePanel'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import DraftConflictDialog from '@/ui-component/dialog/DraftConflictDialog'
import ChatPopUp from '@/views/chatmessage/ChatPopUp'
import VectorStorePopUp from '@/views/vectorstore/VectorStorePopUp'
import EtlPanel from '@/views/etl/EtlPanel'
import { flowContext } from '@/store/context/ReactFlowContext'
import { CanvasPanelContext } from '@/store/context/CanvasPanelContext'

// API
import nodesApi from '@/api/nodes'
import chatflowsApi from '@/api/chatflows'
import harnessesApi from '@/api/harnesses'
import credentialsApi from '@/api/credentials'
import BuildLandingDialog from '@/ui-component/dialog/BuildLandingDialog'
import etlApi from '@/api/etl'
import flowDraftsApi from '@/api/flowDrafts'

// Hooks
import useApi from '@/hooks/useApi'
import useConfirm from '@/hooks/useConfirm'
import useCanvasLook from '@/hooks/useCanvasLook'
import useDraftSave from '@/hooks/useDraftSave'
import { useAuth } from '@/hooks/useAuth'

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
import { getUniqueNodeId, initNode, getUpsertDetails, updateOutdatedNodeData } from '@/utils/genericHelper'
import { applyEdgeRefs, healImportedFlow, needsSync } from '@/utils/edgeRefs'
import { readyToFit, FIT_ON_OPEN } from '@/utils/canvasFit'
import { templateKeyNote, templateWithYourKey } from '@/utils/yourKey'
import { templateSettingsMessage } from '@/utils/templateSettingsNote'
import useNotifier from '@/utils/useNotifier'
import { usePrompt } from '@/utils/usePrompt'
import { CHATFLOW_NEEDS_ENDING_NODE, chatflowCanChat } from '@/utils/chatflowReady'
import { harnessChatBlock, reservedHarnessNameMessage } from '@/utils/harnessChatReady'
import { nodeMoved } from '@/utils/canvasDirty'
import { panelNode, panToKeepInView } from '@/utils/canvasLook'
import { createCanvasDeleteQueue, panelStateWhenNodesChange } from '@/views/canvas/cardActions'
import { flowiseCanvasJson } from '@/utils/flowiseImport'
import { hydrateLangflowFlow, isLangflowExport, langflowToFlowise } from '@/utils/langflowImport'
import { hydrateRawCanvasNodes, normalizeCanvasFlow, repairFlowEdges, specsByName, stripRawCanvasMarker } from '@/utils/normalizeCanvasFlow'
import { apiErrorMessage, canvasFlowText, canvasTextToApply, planCanvasSave } from '@/utils/flowDrafts'
import { canvasSaveDocument } from '@/utils/canvasSave'
import {
    asSavedCards,
    canvasIsEmpty,
    compactForNewLook,
    harnessNameFrom,
    pipelineNameFrom,
    starterQuestionsOf,
    stashNewCanvas,
    takeLanding,
    missingCredentialsText,
    noteSavedBuild,
    takeSavedBuild,
    withStarterQuestions
} from '@/utils/buildWithAI'

// const
import { FLOWISE_CREDENTIAL_ID, uiBaseURL } from '@/store/constant'

const nodeTypes = { customNode: CanvasNode, stickyNote: StickyNote }
const edgeTypes = { buttonedge: ButtonEdge }

// Tall cards dropped on the same point hide the one underneath. Step down-right until the headers can be read.
const separateFromExisting = (position, nodes) => {
    let next = { x: position.x, y: position.y }
    const collides = (node) => {
        const x = node.position?.x ?? 0
        const y = node.position?.y ?? 0
        return Math.abs(x - next.x) < 36 && Math.abs(y - next.y) < 64
    }
    let guard = 0
    while ((nodes || []).some(collides) && guard < 24) {
        next = { x: next.x + 64, y: next.y + 120 }
        guard += 1
    }
    return next
}

// ==============================|| CANVAS ||============================== //

const Canvas = () => {
    const theme = useTheme()
    const navigate = useNavigate()
    const { hasAssignedWorkspace } = useAuth()

    const { state } = useLocation()
    const templateFlowData = state ? state.templateFlowData : ''

    const URLpath = document.location.pathname.toString().split('/')
    const chatflowId =
        URLpath[URLpath.length - 1] === 'canvas' ||
        URLpath[URLpath.length - 1] === 'agentcanvas' ||
        URLpath[URLpath.length - 1] === 'harnesscanvas' ||
        URLpath[URLpath.length - 1] === 'etlcanvas'
            ? ''
            : URLpath[URLpath.length - 1]
    const isAgentCanvas = URLpath.includes('agentcanvas') ? true : false
    const isHarnessCanvas = URLpath.includes('harnesscanvas')
    const isEtlCanvas = URLpath.includes('etlcanvas')
    const isChatCanvas = !isAgentCanvas && !isHarnessCanvas && !isEtlCanvas
    const canvasTitle = isEtlCanvas ? 'Pipeline' : isHarnessCanvas ? 'Harness' : isAgentCanvas ? 'Agent' : 'Chatflow'

    const { confirm } = useConfirm()

    const dispatch = useDispatch()
    const customization = useSelector((state) => state.customization)
    const canvas = useSelector((state) => state.canvas)
    const [canvasDataStore, setCanvasDataStore] = useState(canvas)
    const [chatflow, setChatflow] = useState(null)
    const [draftStatus, setDraftStatusState] = useState(null)
    const draftStatusRef = useRef(null)
    const fitOnOpenRef = useRef(false)
    const draftSave = useDraftSave()
    const pendingSaveNameRef = useRef('')
    const setDraftStatus = (status) => {
        draftStatusRef.current = status
        setDraftStatusState(status)
    }
    const chatflowRef = useRef(null)
    // Build with AI on a chatflow: starter questions wait here until the first save, and a built chatflow that was
    // never saved keeps Live empty on that first save, so it lands as a draft.
    const builderStartersRef = useRef([])
    const firstSaveAsDraftRef = useRef(false)
    const pendingDraftRef = useRef(null)
    const [builtResult, setBuiltResult] = useState(null)
    const pendingLangflow = useRef(null)
    const dragOrigin = useRef(new Map())
    chatflowRef.current = chatflow
    const { reactFlowInstance, setReactFlowInstance, deleteNode, deleteSelection, applyingDelete, bindCanvasState, duplicateNode } =
        useContext(flowContext)

    // ==============================|| Snackbar ||============================== //

    useNotifier()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    // ==============================|| ReactFlow ||============================== //

    const [nodes, setNodes, onNodesChange] = useNodesState()
    const [edges, setEdges, onEdgesChange] = useEdgesState()
    bindCanvasState(setNodes, setEdges)
    // Keyboard Delete and Backspace emit remove changes for every selected card and its lines. One pass deletes
    // that whole set. Drag and select still go through the React Flow handler. The pipeline canvas uses this too.
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

    const [selectedNode, setSelectedNode] = useState(null)
    const [canvasLook, setCanvasLook] = useCanvasLook()
    const sidePanelOn = canvasLook === 'panel'
    const [panelNodeId, setPanelNodeId] = useState(null)
    const [isUpsertButtonEnabled, setIsUpsertButtonEnabled] = useState(false)
    const [isSyncNodesButtonEnabled, setIsSyncNodesButtonEnabled] = useState(false)
    const [isSnappingEnabled, setIsSnappingEnabled] = useState(false)
    const [paletteOpen, setPaletteOpen] = useState(false)
    const [isBackgroundEnabled, setIsBackgroundEnabled] = useState(true)

    const reactFlowWrapper = useRef(null)

    const [lastUpdatedDateTime, setLasUpdatedDateTime] = useState('')
    const [chatflowName, setChatflowName] = useState('')
    const [flowData, setFlowData] = useState('')

    // ==============================|| Chatflow API ||============================== //

    const getNodesApi = useApi(nodesApi.getAllNodes)
    const getPackIndexApi = useApi(nodesApi.getNodePackIndex)
    const createNewChatflowApi = useApi(chatflowsApi.createNewChatflow)
    const updateChatflowApi = useApi(chatflowsApi.updateChatflow)
    const getSpecificChatflowApi = useApi(chatflowsApi.getSpecificChatflow)
    const getHasChatflowChangedApi = useApi(chatflowsApi.getHasChatflowChanged)

    // ==============================|| Events & Actions ||============================== //

    const onConnect = (params) => {
        const newEdge = {
            ...params,
            type: 'buttonedge',
            id: `${params.source}-${params.sourceHandle}-${params.target}-${params.targetHandle}`
        }

        setNodes((currentNodes) => {
            const result = applyEdgeRefs(currentNodes, [newEdge], { canvasType: isAgentCanvas ? 'MULTIAGENT' : 'CHATFLOW' })
            for (const message of result.unmatched) showImportError(message)
            return result.nodes
        })

        setEdges((eds) => addEdge(newEdge, eds))
        setTimeout(() => setDirty(), 0)
    }

    const showImportError = (message) => {
        enqueueSnackbar({
            message,
            options: {
                key: new Date().getTime() + Math.random(),
                variant: 'warning',
                persist: true,
                action: (key) => (
                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                        <IconX />
                    </Button>
                )
            }
        })
    }

    const commitLangflow = (payload, catalog) => {
        const hydrated = hydrateLangflowFlow(payload.flow, catalog)
        if (!hydrated.ok) {
            showImportError(hydrated.reason)
            return
        }
        setNodes(hydrated.nodes)
        setEdges(hydrated.edges)
        setTimeout(() => setDirty(), 0)
        if (!chatflowRef.current?.id && payload.name) {
            dispatch({ type: SET_CHATFLOW, chatflow: { name: payload.name } })
        }
    }

    const queueLangflow = (payload) => {
        if (Array.isArray(getNodesApi.data)) {
            pendingLangflow.current = null
            commitLangflow(payload, getNodesApi.data)
            return
        }
        pendingLangflow.current = payload
    }

    const canvasSpecs = () => specsByName(Array.isArray(getNodesApi.data) ? getNodesApi.data : canvas.componentNodes)

    const applyFlowiseCanvas = (canvasText) => {
        const specs = canvasSpecs()
        const flowData = normalizeCanvasFlow(JSON.parse(canvasText), specs)
        const healed = healImportedFlow(flowData.nodes || [], flowData.edges || [], specs, {
            canvasType: isAgentCanvas ? 'MULTIAGENT' : 'CHATFLOW',
            updateNodeData: updateOutdatedNodeData
        })
        setNodes(healed.nodes)
        setEdges(healed.edges)
        checkIfSyncNodesAvailable(healed.nodes)
        for (const message of healed.attention) showImportError(message)
        setTimeout(() => setDirty(), 0)
    }

    const handleLoadFlow = (file, expect = 'either') => {
        let parsed
        try {
            parsed = JSON.parse(file)
        } catch (e) {
            console.error(e)
            showImportError(expect === 'langflow' ? 'That file is not a Langflow export.' : 'That file is not a Flowise chatflow JSON.')
            return
        }
        if (parsed && parsed.cuttlelyLangflow && parsed.flow) {
            queueLangflow(parsed)
            return
        }
        if (parsed && parsed.cuttlelyMigration && parsed.flow) {
            applyFlowiseCanvas(JSON.stringify(parsed.flow))
            return
        }
        const langflow = isLangflowExport(parsed)
        const flowise = langflow ? null : flowiseCanvasJson(parsed)
        if (expect === 'flowise') {
            if (!flowise) {
                showImportError(
                    langflow ? 'That file is Langflow JSON. Use Import Langflow JSON.' : 'That file is not a Flowise chatflow JSON.'
                )
                return
            }
            applyFlowiseCanvas(flowise)
            return
        }
        if (expect === 'langflow' || (expect === 'either' && langflow)) {
            if (!langflow) {
                showImportError(flowise ? 'That file is Flowise JSON. Use Import Flowise JSON.' : 'That file is not a Langflow export.')
                return
            }
            const result = langflowToFlowise(parsed)
            if (!result.ok) {
                showImportError(result.reason)
                return
            }
            queueLangflow({ cuttlelyLangflow: true, name: result.name, flow: result.flow })
            return
        }
        if (!flowise) {
            showImportError('That file is not a Flowise chatflow JSON.')
            return
        }
        applyFlowiseCanvas(flowise)
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
                navigate(isEtlCanvas ? '/etl' : isHarnessCanvas ? '/harnesses' : isAgentCanvas ? '/agentflows' : '/')
            } catch (error) {
                enqueueSnackbar({
                    message: typeof error.response.data === 'object' ? error.response.data.message : error.response.data,
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
        getSpecificChatflowApi.request(chatflow.id)
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
        // The settings panel's dropdowns keep the value they opened with, so the panel closes on a new canvas.
        setPanelNodeId(null)
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
        draftSave.openConflict(chatflow.id, found, JSON.stringify(canvasSaveDocument(reactFlowInstance)))
    }

    const normalizeForMerge = (flow) => normalizeCanvasFlow(flow, canvasSpecs())

    const handleSaveFlow = async (chatflowName, saveOptions) => {
        if (typeof chatflowName === 'string') pendingSaveNameRef.current = chatflowName
        if (reactFlowInstance) {
            const rfInstanceObject = canvasSaveDocument(reactFlowInstance)
            const flowData = JSON.stringify(rfInstanceObject)

            if (!isAgentCanvas && !isHarnessCanvas && !isEtlCanvas && !chatflowCanChat(rfInstanceObject)) {
                enqueueSnackbar({
                    message: CHATFLOW_NEEDS_ENDING_NODE,
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'warning',
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
            }

            if (!chatflow.id) {
                const newChatflowBody = {
                    name: chatflowName,
                    deployed: false,
                    isPublic: false,
                    flowData,
                    type: isEtlCanvas ? 'ETL' : isHarnessCanvas ? 'HARNESS' : isAgentCanvas ? 'MULTIAGENT' : 'CHATFLOW'
                }
                if (isChatCanvas) {
                    const chatbotConfig = withStarterQuestions(undefined, builderStartersRef.current)
                    if (chatbotConfig) newChatflowBody.chatbotConfig = chatbotConfig
                    if (firstSaveAsDraftRef.current) {
                        pendingDraftRef.current = flowData
                        newChatflowBody.flowData = JSON.stringify({ nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } })
                    }
                }
                createNewChatflowApi.request(newChatflowBody)
            } else {
                const plan = planCanvasSave({
                    mode: draftStatusRef.current?.mode,
                    name: chatflowName,
                    savedName: chatflow.name,
                    flowData,
                    hasId: true
                })
                if (plan.draft) {
                    try {
                        const res = await draftSave.save(chatflow.id, plan.draft.flowData, saveOptions)
                        if (res?.conflict) return
                        setDraftStatus(res.data)
                    } catch (error) {
                        errorFailed(apiErrorMessage(error, 'Save failed'))
                        return
                    }
                }
                if (plan.live?.flowData) {
                    setChatflowName(plan.live.name)
                    setFlowData(plan.live.flowData)
                    getHasChatflowChangedApi.request(chatflow.id, lastUpdatedDateTime)
                    return
                }
                if (plan.live?.name) {
                    try {
                        const res = await chatflowsApi.updateChatflow(chatflow.id, { name: plan.live.name })
                        dispatch({ type: SET_CHATFLOW, chatflow: res.data })
                        setLasUpdatedDateTime(res.data.updatedDate)
                    } catch (error) {
                        errorFailed(apiErrorMessage(error, 'Save failed'))
                        return
                    }
                }
                if (plan.draft) saveChatflowSuccess('Draft saved')
                if (isChatCanvas) saveBuilderStarters(chatflow)
            }
        }
    }

    // eslint-disable-next-line
    const onNodeClick = useCallback((event, clickedNode) => {
        setSelectedNode(clickedNode)
        setPanelNodeId(clickedNode.type === 'stickyNote' ? null : clickedNode.id)
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

    const onDragOver = useCallback((event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
    }, [])

    const placeNode = useCallback(
        (nodeData, position, { frame } = {}) => {
            if (!reactFlowInstance || !nodeData) return
            const existing = reactFlowInstance.getNodes()
            const placed = separateFromExisting(position, existing)
            const newNodeId = getUniqueNodeId(nodeData, existing)
            const newNode = {
                id: newNodeId,
                position: placed,
                type: nodeData.type !== 'StickyNote' ? 'customNode' : 'stickyNote',
                data: initNode(nodeData, newNodeId)
            }

            setSelectedNode(newNode)
            setPanelNodeId(newNode.type === 'customNode' ? newNodeId : null)
            setNodes((nds) =>
                (nds || []).concat(newNode).map((node) => {
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
            )
            setTimeout(() => setDirty(), 0)
            if (frame) {
                setTimeout(() => {
                    reactFlowInstance.fitView({ nodes: [{ id: newNodeId }], padding: 0.35, duration: 200, maxZoom: 1 })
                }, 50)
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [reactFlowInstance]
    )

    const onPlaceNode = useCallback(
        (nodeData) => {
            if (!reactFlowInstance || !reactFlowWrapper.current) return
            const bounds = reactFlowWrapper.current.getBoundingClientRect()
            const position = reactFlowInstance.project({
                x: Math.min(Math.max(bounds.width * 0.28, 80), 320),
                y: 96
            })
            placeNode(cloneDeep(nodeData), position, { frame: true })
        },
        [placeNode, reactFlowInstance]
    )

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
            placeNode(nodeData, position)
        },

        // eslint-disable-next-line
        [reactFlowInstance, placeNode]
    )

    const syncNodes = () => {
        const healed = healImportedFlow(nodes, edges, canvas.componentNodes, {
            canvasType: isAgentCanvas ? 'MULTIAGENT' : 'CHATFLOW',
            updateNodeData: updateOutdatedNodeData
        })
        setNodes(healed.nodes)
        setEdges(healed.edges)
        for (const message of healed.attention) showImportError(message)
        setDirty()
        setIsSyncNodesButtonEnabled(false)
    }

    const saveChatflowSuccess = (message = `${canvasTitle} saved`) => {
        dispatch({ type: REMOVE_DIRTY })
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

    const apiErrorText = (error) => {
        const data = error?.response?.data
        if (data && typeof data === 'object' && data.message) return data.message
        if (typeof data === 'string' && data) return data
        return error?.message || 'Save failed'
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

    const getEtlFlowData = useCallback(() => {
        if (!reactFlowInstance) return chatflow?.flowData
        const flow = reactFlowInstance.toObject()
        flow.nodes = flow.nodes.map((node) => {
            const data = cloneDeep(node.data)
            stripRawCanvasMarker(data)
            if (data.inputs && Object.prototype.hasOwnProperty.call(data.inputs, FLOWISE_CREDENTIAL_ID)) {
                data.credential = data.inputs[FLOWISE_CREDENTIAL_ID]
                data.inputs = omit(data.inputs, [FLOWISE_CREDENTIAL_ID])
            }
            return { ...node, data }
        })
        return JSON.stringify(flow)
    }, [reactFlowInstance, chatflow])

    const restoreEtlVersion = (flowData) => {
        const flow = normalizeCanvasFlow(JSON.parse(flowData), canvasSpecs())
        setNodes(flow.nodes || [])
        setEdges(flow.edges || [])
        setDirty()
    }

    const setDirty = () => {
        dispatch({ type: SET_DIRTY })
    }

    const onNodeDragStart = (_event, node) => {
        if (!node?.id || !node.position) return
        dragOrigin.current.set(node.id, { x: node.position.x, y: node.position.y })
    }

    const onNodeDragStop = (_event, node) => {
        const start = node?.id ? dragOrigin.current.get(node.id) : null
        if (node?.id) dragOrigin.current.delete(node.id)
        if (nodeMoved(start, node?.position)) setDirty()
    }

    const checkIfUpsertAvailable = (nodes, edges) => {
        const upsertNodeDetails = getUpsertDetails(nodes, edges)
        if (upsertNodeDetails.length) setIsUpsertButtonEnabled(true)
        else setIsUpsertButtonEnabled(false)
    }

    const checkIfSyncNodesAvailable = (nodes) => {
        const componentNodes = canvas.componentNodes

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i]
            const componentNode = componentNodes.find((cn) => cn.name === node.data.name)
            if (needsSync(node, componentNode)) {
                setIsSyncNodesButtonEnabled(true)
                return
            }
        }

        setIsSyncNodesButtonEnabled(false)
    }

    // ==============================|| useEffect ||============================== //

    // Get specific chatflow successful
    const readGraph = (text) => {
        if (!text) return { nodes: [], edges: [] }
        return normalizeCanvasFlow(JSON.parse(text), canvasSpecs())
    }

    const applyCanvasText = (text) => {
        if (!canvasTextToApply(text)) return
        try {
            const flow = readGraph(text)
            setNodes(flow.nodes || [])
            setEdges(flow.edges || [])
        } catch {
            return
        }
        setPanelNodeId(null)
        dispatch({ type: REMOVE_DIRTY })
        // Discard, Publish and rollback replace the canvas with a saved one, and set the new draft status first.
        // The next save and the review screen build on that canvas, not on the draft that was open before.
        draftSave.record(draftStatusRef.current, text)
    }

    // ==============================|| Build with AI ||============================== //

    // A built harness or pipeline is always a new one: it is saved under a free name with its starter questions,
    // then opens on its own canvas, here when this canvas is new and empty, otherwise in a new tab so nothing here
    // is lost.
    const buildKind = isHarnessCanvas ? 'harness' : isEtlCanvas ? 'etl' : isChatCanvas ? 'chat' : undefined

    // The first save of a built chatflow: Live stays empty and the built cards become the draft, so the test chat
    // runs the draft and Publish puts it live. A server with drafts off keeps the old way: the cards go live.
    const saveFirstDraft = async (created, draft) => {
        try {
            const res = await draftSave.save(created.id, draft)
            if (res?.conflict) return
            setDraftStatus(res.data)
            saveChatflowSuccess('Saved as a draft. Live stays empty until you publish.')
        } catch {
            try {
                const res = await chatflowsApi.updateChatflow(created.id, { flowData: draft })
                dispatch({ type: SET_CHATFLOW, chatflow: res.data })
                saveChatflowSuccess()
            } catch (error) {
                errorFailed(apiErrorMessage(error, 'Save failed'))
            }
        }
    }

    // Starter questions from a build join the chat settings on the next save of a flow that has none.
    const saveBuilderStarters = async (savedFlow) => {
        const questions = builderStartersRef.current
        if (!savedFlow?.id || !questions.length) return
        builderStartersRef.current = []
        const chatbotConfig = withStarterQuestions(savedFlow.chatbotConfig, questions)
        if (!chatbotConfig) return
        try {
            const res = await chatflowsApi.updateChatflow(savedFlow.id, { chatbotConfig })
            dispatch({ type: SET_CHATFLOW, chatflow: res.data })
        } catch (error) {
            errorFailed(apiErrorMessage(error, 'Saving the starter questions failed'))
        }
    }

    const closeAction = (key) => (
        <Button style={{ color: 'white' }} aria-label='Close' onClick={() => closeSnackbar(key)}>
            <IconX />
        </Button>
    )

    // A built chatflow lands on the canvas unsaved: in place on an empty canvas, or in place of the old cards
    // after Replace, with Undo.
    const placeBuiltChat = (result, replaced) => {
        const previous = replaced ? { nodes: reactFlowInstance.getNodes(), edges: reactFlowInstance.getEdges() } : null
        const previousStarters = builderStartersRef.current
        const cards = sidePanelOn ? compactForNewLook(result.nodes) : result.nodes
        setNodes(cards)
        setEdges(result.edges)
        builderStartersRef.current = result.starterQuestions || []
        if (!chatflowRef.current?.id) {
            firstSaveAsDraftRef.current = true
            if (result.title) dispatch({ type: SET_CHATFLOW, chatflow: { ...(chatflowRef.current || {}), name: result.title } })
        }
        setTimeout(() => {
            setDirty()
            reactFlowInstance?.fitView({ padding: 0.2 })
        }, 0)
        const missing = missingCredentialsText(result.missingCredentials)
        const name = result.title ? `"${result.title}"` : 'The chatflow'
        enqueueSnackbar({
            message: `${name} is on the canvas${replaced ? ' in place of the old cards' : ''}. Save to keep it as a draft.${
                missing ? ` ${missing}` : ''
            }`,
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
                                    setNodes(previous.nodes)
                                    setEdges(previous.edges)
                                    builderStartersRef.current = previousStarters
                                    closeSnackbar(key)
                                }}
                            >
                                Undo
                            </Button>
                        )}
                        {closeAction(key)}
                    </>
                )
            }
        })
    }

    const startNewBuilt = () => {
        stashNewCanvas(builtResult)
        setBuiltResult(null)
        window.open(`${uiBaseURL}/canvas`, '_blank')
    }

    const replaceWithBuilt = () => {
        const result = builtResult
        setBuiltResult(null)
        placeBuiltChat(result, true)
    }
    const builtAs = isEtlCanvas
        ? { what: 'pipeline', type: 'ETL', path: 'etlcanvas', next: 'Its starter searches wait under Try retrieval after the first run.' }
        : { what: 'harness', type: 'HARNESS', path: 'harnesscanvas', next: 'Its starter questions wait in the test chat.' }

    const builtNotice = (built) => {
        const missing = missingCredentialsText(built.missingCredentials)
        enqueueSnackbar({
            message: `Built "${built.title}" as a new ${builtAs.what}. ${builtAs.next}${missing ? ` ${missing}` : ''}`,
            options: {
                key: new Date().getTime() + Math.random(),
                variant: built.missingCredentials?.length ? 'warning' : 'success',
                persist: Boolean(built.missingCredentials?.length),
                action: (key) => (
                    <Button style={{ color: 'white' }} aria-label='Close' onClick={() => closeSnackbar(key)}>
                        <IconX />
                    </Button>
                )
            }
        })
    }

    const takenNames = () =>
        (isEtlCanvas ? etlApi.listPipelines() : harnessesApi.listHarnesses())
            .then((res) => (Array.isArray(res.data) ? res.data.map((item) => item.name) : []))
            .catch(() => [])

    const onBuilt = async (result) => {
        if (isChatCanvas) {
            if (canvasIsEmpty(reactFlowInstance?.getNodes() || [], reactFlowInstance?.getEdges() || [])) placeBuiltChat(result, false)
            else setBuiltResult(result)
            return
        }
        try {
            const taken = await takenNames()
            const name = isEtlCanvas ? pipelineNameFrom(result.title, taken) : harnessNameFrom(result.title, taken)
            const cards = asSavedCards(sidePanelOn ? compactForNewLook(result.nodes) : result.nodes)
            const flowData = JSON.stringify({ nodes: cards, edges: result.edges, viewport: { x: 0, y: 0, zoom: 1 } })
            const body = { name, deployed: false, isPublic: false, type: builtAs.type, flowData }
            const chatbotConfig = withStarterQuestions(undefined, result.starterQuestions)
            if (chatbotConfig) body.chatbotConfig = chatbotConfig
            const created = (await chatflowsApi.createNewChatflow(body)).data
            noteSavedBuild(created.id, { ...result, title: name })
            const here = !chatflowRef.current?.id && !(reactFlowInstance?.getNodes() || []).length && !canvasDataStore.isDirty
            const url = `${uiBaseURL}/${builtAs.path}/${created.id}`
            if (here) window.location.assign(url)
            else window.open(url, '_blank')
        } catch (error) {
            errorFailed(apiErrorMessage(error, `Saving the built ${builtAs.what} failed`))
        }
    }

    useEffect(() => {
        if (getSpecificChatflowApi.data) {
            const loaded = getSpecificChatflowApi.data
            const workspaceId = loaded.workspaceId
            if (!hasAssignedWorkspace(workspaceId)) {
                navigate('/unauthorized')
                return
            }
            let cancelled = false
            const paint = (status) => {
                if (cancelled) return
                setDraftStatus(status)
                const text = canvasFlowText(loaded, status)
                draftSave.record(status, text)
                try {
                    const initialFlow = readGraph(text)
                    setLasUpdatedDateTime(loaded.updatedDate)
                    fitOnOpenRef.current = true
                    setNodes(initialFlow.nodes || [])
                    setEdges(initialFlow.edges || [])
                } catch {
                    try {
                        const fallback = readGraph(loaded.flowData)
                        setNodes(fallback.nodes || [])
                        setEdges(fallback.edges || [])
                    } catch {
                        setNodes([])
                        setEdges([])
                    }
                }
                dispatch({ type: SET_CHATFLOW, chatflow: loaded })
                dispatch({ type: REMOVE_DIRTY })
            }
            const built = takeSavedBuild(loaded.id)
            if (built) builtNotice(built)
            // Chatflow, agentflow, harness and pipeline canvases load draft status the same way.
            // The canvas shows the draft. Harness runs and pipeline runs keep serving Live until Publish.
            flowDraftsApi
                .getStatus(loaded.id)
                .then((res) => paint(res.data))
                .catch(() => paint({ enabled: false, mode: 'live', reason: 'off', draft: null }))
            return () => {
                cancelled = true
            }
        } else if (getSpecificChatflowApi.error) {
            errorFailed(`Failed to retrieve ${canvasTitle}: ${getSpecificChatflowApi.error.response.data.message}`)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getSpecificChatflowApi.data, getSpecificChatflowApi.error])

    // A saved flow opens zoomed to fit its cards, once React Flow has measured them.
    useEffect(() => {
        if (!fitOnOpenRef.current || !reactFlowInstance || !readyToFit(nodes)) return
        fitOnOpenRef.current = false
        reactFlowInstance.fitView(FIT_ON_OPEN)
    }, [nodes, reactFlowInstance])

    // Create new chatflow successful
    useEffect(() => {
        if (createNewChatflowApi.data) {
            const chatflow = createNewChatflowApi.data
            dispatch({ type: SET_CHATFLOW, chatflow })
            builderStartersRef.current = []
            firstSaveAsDraftRef.current = false
            const draft = pendingDraftRef.current
            pendingDraftRef.current = null
            if (draft) {
                saveFirstDraft(chatflow, draft)
            } else {
                saveChatflowSuccess()
            }
            if (!draft) {
                flowDraftsApi
                    .getStatus(chatflow.id)
                    .then((res) => {
                        setDraftStatus(res.data)
                        draftSave.record(res.data, canvasFlowText(chatflow, res.data))
                    })
                    .catch(() => undefined)
            }
            window.history.replaceState(
                state,
                null,
                `/${isEtlCanvas ? 'etlcanvas' : isHarnessCanvas ? 'harnesscanvas' : isAgentCanvas ? 'agentcanvas' : 'canvas'}/${
                    chatflow.id
                }`
            )
        } else if (createNewChatflowApi.error) {
            errorFailed(apiErrorText(createNewChatflowApi.error))
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [createNewChatflowApi.data, createNewChatflowApi.error])

    // Update chatflow successful
    useEffect(() => {
        if (updateChatflowApi.data) {
            dispatch({ type: SET_CHATFLOW, chatflow: updateChatflowApi.data })
            setLasUpdatedDateTime(updateChatflowApi.data.updatedDate)
            saveChatflowSuccess()
        } else if (updateChatflowApi.error) {
            errorFailed(apiErrorText(updateChatflowApi.error))
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [updateChatflowApi.data, updateChatflowApi.error])

    // check if chatflow has changed before saving
    useEffect(() => {
        const checkIfHasChanged = async () => {
            if (getHasChatflowChangedApi.data?.hasChanged === true) {
                const confirmPayload = {
                    title: `Confirm Change`,
                    description: `${canvasTitle} ${chatflow.name} has changed since you have opened, overwrite changes?`,
                    confirmButtonName: 'Confirm',
                    cancelButtonName: 'Cancel'
                }
                const isConfirmed = await confirm(confirmPayload)

                if (!isConfirmed) {
                    return
                }
            }
            const updateBody = {
                name: chatflowName,
                flowData
            }
            updateChatflowApi.request(chatflow.id, updateBody)
        }

        if (getHasChatflowChangedApi.data) {
            checkIfHasChanged()
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getHasChatflowChangedApi.data, getHasChatflowChangedApi.error])

    useEffect(() => {
        setChatflow(canvasDataStore.chatflow)
        if (canvasDataStore.chatflow) {
            const flowData = canvasDataStore.chatflow.flowData ? JSON.parse(canvasDataStore.chatflow.flowData) : []
            checkIfUpsertAvailable(flowData.nodes || [], flowData.edges || [])
            checkIfSyncNodesAvailable(flowData.nodes || [])
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasDataStore.chatflow])

    // Initialization
    useEffect(() => {
        setIsSyncNodesButtonEnabled(false)
        setIsUpsertButtonEnabled(false)
        if (chatflowId) {
            getSpecificChatflowApi.request(chatflowId)
        } else {
            let importedName = ''
            const storedFlow = localStorage.getItem('duplicatedFlowData')
            if (storedFlow) {
                try {
                    const stored = JSON.parse(storedFlow)
                    if (stored && stored.cuttlelyMigration && typeof stored.name === 'string' && stored.name.trim()) {
                        importedName = stored.name.trim()
                    }
                } catch {
                    importedName = ''
                }
                handleLoadFlow(storedFlow)
                setTimeout(() => localStorage.removeItem('duplicatedFlowData'), 0)
                if (isHarnessCanvas && reservedHarnessNameMessage(importedName)) {
                    showImportError(reservedHarnessNameMessage(importedName))
                    importedName = ''
                }
                const landing = isChatCanvas ? takeLanding() : null
                if (landing) {
                    builderStartersRef.current = landing.starterQuestions
                    firstSaveAsDraftRef.current = true
                    const missing = missingCredentialsText(landing.missingCredentials)
                    if (missing)
                        enqueueSnackbar({
                            message: missing,
                            options: { key: new Date().getTime() + Math.random(), variant: 'warning', persist: true, action: closeAction }
                        })
                }
            } else {
                setNodes([])
                setEdges([])
            }
            dispatch({
                type: SET_CHATFLOW,
                chatflow: {
                    name:
                        importedName ||
                        (isEtlCanvas ? 'Untitled pipeline' : isHarnessCanvas ? 'untitled-harness' : `Untitled ${canvasTitle}`)
                }
            })
        }

        getNodesApi.request()
        getPackIndexApi.request()

        // Clear dirty state before leaving and remove any ongoing test triggers and webhooks
        return () => {
            setTimeout(() => dispatch({ type: REMOVE_DIRTY }), 0)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        const rows = getPackIndexApi.data?.nodes
        if (!Array.isArray(rows)) return
        dispatch({ type: SET_NODE_PACK_INDEX, nodePackIndex: rows })
    }, [getPackIndexApi.data, dispatch])

    useEffect(() => {
        if (!pendingLangflow.current || !Array.isArray(getNodesApi.data)) return
        const payload = pendingLangflow.current
        pendingLangflow.current = null
        commitLangflow(payload, getNodesApi.data)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getNodesApi.data])

    useEffect(() => {
        if (!Array.isArray(getNodesApi.data)) return
        setNodes((current) => {
            const next = hydrateRawCanvasNodes(current, getNodesApi.data)
            if (next !== current) {
                setEdges((edges) => repairFlowEdges({ nodes: next, edges }).edges)
            }
            return next
        })
    }, [getNodesApi.data, setNodes, setEdges])

    useEffect(() => {
        setCanvasDataStore(canvas)
    }, [canvas])

    useEffect(() => {
        function handlePaste(e) {
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
    }, [])

    // A harness template opens on the person's own model key (see utils/yourKey).
    const loadHarnessTemplate = async (text) => {
        let note = ''
        let flowText = text
        try {
            const credentials = await credentialsApi.getAllCredentials()
            let specs = canvasSpecs()
            if (![...specs.values()].some((spec) => spec?.category === 'Chat Models')) {
                specs = specsByName((await nodesApi.getNodesByCategory('Chat Models')).data || [])
            }
            const { flow, changed } = templateWithYourKey(JSON.parse(text), specs, credentials.data || [])
            note = templateKeyNote(changed)
            if (note) flowText = JSON.stringify(flow)
        } catch {
            note = ''
        }
        handleLoadFlow(flowText)
        if (note)
            enqueueSnackbar({
                message: note,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'info',
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
    }

    useEffect(() => {
        if (templateFlowData && templateFlowData.includes('"nodes":[') && templateFlowData.includes('],"edges":[')) {
            const settingsNote = templateSettingsMessage(templateFlowData)
            if (isHarnessCanvas) loadHarnessTemplate(templateFlowData)
            else handleLoadFlow(templateFlowData)
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

    // New look: with the switch on, cards are compact and clicking a card opens its settings in a side panel on the right.
    const openPanelNode = panelNode(nodes, sidePanelOn ? panelNodeId : null)
    const openPanelNodeId = openPanelNode?.id ?? null
    const panelOpenRef = useRef(false)
    panelOpenRef.current = Boolean(openPanelNodeId)
    // Duplicating while the panel is open selects the copy and moves the panel onto it.
    const onDuplicated = useCallback((created) => {
        const newId = created?.id
        if (newId && panelOpenRef.current) setPanelNodeId(newId)
    }, [])
    const panelContext = useMemo(
        () => ({ panelNodeId: openPanelNodeId, compact: sidePanelOn, onDuplicated }),
        [openPanelNodeId, sidePanelOn, onDuplicated]
    )
    // A deleted card must not leave its id open. The next card of that type reuses the id.
    useEffect(() => {
        const next = panelStateWhenNodesChange({ panelNodeId, nodes })
        if (next.panelNodeId !== panelNodeId) setPanelNodeId(null)
    }, [nodes, panelNodeId])

    // The panel narrows the canvas. Pan so the card you clicked does not end up behind it.
    useEffect(() => {
        if (!openPanelNodeId || !reactFlowInstance) return
        const timer = setTimeout(() => {
            const node = reactFlowInstance.getNode?.(openPanelNodeId)
            const width = reactFlowWrapper.current?.getBoundingClientRect().width
            if (!node) return
            const at = node.positionAbsolute || node.position
            const next = panToKeepInView(
                { x: at.x, y: at.y, width: node.width, height: node.height },
                reactFlowInstance.getViewport(),
                width
            )
            if (next) reactFlowInstance.setViewport(next, { duration: 200 })
        }, 60)
        return () => clearTimeout(timer)
    }, [openPanelNodeId, reactFlowInstance])

    return (
        <>
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
                            handleDeleteFlow={handleDeleteFlow}
                            handleLoadFlow={handleLoadFlow}
                            onApplyMigration={({ canvas, name }) => {
                                applyFlowiseCanvas(JSON.stringify(canvas))
                                if (!chatflowRef.current?.id && name) {
                                    dispatch({ type: SET_CHATFLOW, chatflow: { name } })
                                }
                            }}
                            isAgentCanvas={isAgentCanvas}
                            isHarnessCanvas={isHarnessCanvas}
                            isEtlCanvas={isEtlCanvas}
                            draftStatus={draftStatus}
                            onDraftStatus={setDraftStatus}
                            onChatflowUpdated={(next) => {
                                dispatch({ type: SET_CHATFLOW, chatflow: next })
                                if (next?.updatedDate) setLasUpdatedDateTime(next.updatedDate)
                            }}
                            onApplyCanvas={applyCanvasText}
                            draftExpected={draftSave.expected}
                            onDraftConflict={reviewPublishConflict}
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
                                        onPaneClick={() => setPanelNodeId(null)}
                                        onEdgesChange={handleEdgesChange}
                                        onDrop={onDrop}
                                        onDragOver={onDragOver}
                                        onNodeDragStart={onNodeDragStart}
                                        onNodeDragStop={onNodeDragStop}
                                        nodeTypes={nodeTypes}
                                        edgeTypes={edgeTypes}
                                        onConnect={onConnect}
                                        onInit={setReactFlowInstance}
                                        fitView
                                        deleteKeyCode={canvas.canvasDialogShow ? null : ['Delete', 'Backspace']}
                                        minZoom={0.1}
                                        snapGrid={[25, 25]}
                                        snapToGrid={isSnappingEnabled}
                                        className='chatflow-canvas'
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
                                                onClick={() => setCanvasLook(sidePanelOn ? 'classic' : 'panel')}
                                                title={
                                                    sidePanelOn
                                                        ? 'New card look (compact cards, settings in a side panel): on'
                                                        : 'New card look (compact cards, settings in a side panel): off'
                                                }
                                                aria-label='toggle side panel'
                                                aria-pressed={sidePanelOn}
                                            >
                                                {sidePanelOn ? <IconLayoutSidebarRightFilled /> : <IconLayoutSidebarRight />}
                                            </button>
                                        </Controls>
                                        {isBackgroundEnabled && <Background color='#aaa' gap={16} />}
                                        <AddNodes
                                            isAgentCanvas={isAgentCanvas}
                                            isHarnessCanvas={isHarnessCanvas}
                                            isEtlCanvas={isEtlCanvas}
                                            nodesData={getNodesApi.data}
                                            onPlaceNode={onPlaceNode}
                                            onOpenChange={setPaletteOpen}
                                            buildKind={buildKind}
                                            onBuilt={onBuilt}
                                        />
                                        <BuildLandingDialog
                                            show={Boolean(builtResult)}
                                            title={builtResult?.title}
                                            onStartNew={startNewBuilt}
                                            onReplace={replaceWithBuilt}
                                            onCancel={() => setBuiltResult(null)}
                                        />
                                        {isSyncNodesButtonEnabled && (
                                            <Fab
                                                sx={{
                                                    left: buildKind ? 60 : 40,
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
                                        {isEtlCanvas ? (
                                            <EtlPanel
                                                chatflowId={chatflow?.id}
                                                getFlowData={getEtlFlowData}
                                                isDirty={Boolean(canvasDataStore.isDirty)}
                                                hasDraft={Boolean(draftStatus?.draft)}
                                                onRestore={restoreEtlVersion}
                                                savedAt={chatflow?.updatedDate}
                                                starters={starterQuestionsOf(chatflow?.chatbotConfig)}
                                            />
                                        ) : (
                                            <>
                                                {isUpsertButtonEnabled && <VectorStorePopUp chatflowid={chatflowId} />}
                                                <ChatPopUp
                                                    isAgentCanvas={isAgentCanvas}
                                                    chatflowid={chatflow?.id || chatflowId}
                                                    harnessName={isHarnessCanvas ? chatflow?.name || '' : ''}
                                                    openOnLoad={Boolean(isHarnessCanvas && state?.openChat && chatflow?.id)}
                                                    harnessBlock={
                                                        isHarnessCanvas
                                                            ? harnessChatBlock({
                                                                  saved: Boolean(chatflow?.id || chatflowId),
                                                                  flowReady:
                                                                      !chatflowId ||
                                                                      Boolean(getSpecificChatflowApi.data) ||
                                                                      (Array.isArray(nodes) && nodes.length > 0),
                                                                  nodes,
                                                                  edges,
                                                                  nodeDefinitions: getNodesApi.data
                                                              })
                                                            : ''
                                                    }
                                                />
                                            </>
                                        )}
                                    </ReactFlow>
                                    {(!nodes || nodes.length === 0) && !paletteOpen && (
                                        <Box
                                            sx={{
                                                position: 'absolute',
                                                top: 72,
                                                left: 20,
                                                zIndex: 4,
                                                maxWidth: 460,
                                                pointerEvents: 'none',
                                                color: 'text.secondary',
                                                fontSize: '0.95rem',
                                                lineHeight: 1.45
                                            }}
                                        >
                                            {isEtlCanvas
                                                ? 'Add a source, then a splitter, embeddings, and a vector store.'
                                                : isHarnessCanvas
                                                ? 'Add a Harness Prime and a Harness Specialist. Connect a chat model to Harness Prime, and connect each specialist to Harness Prime.'
                                                : isAgentCanvas
                                                ? 'Add an agent, then connect a chat model.'
                                                : 'Add a Chain, Agent, or Engine, then connect a chat model to it.'}
                                        </Box>
                                    )}
                                </div>
                                {openPanelNode && (
                                    <NodeSidePanel
                                        node={openPanelNode}
                                        onClose={() => setPanelNodeId(null)}
                                        onDuplicate={() => {
                                            const created = duplicateNode(openPanelNode.id)
                                            if (created?.id) onDuplicated(created)
                                        }}
                                        onDelete={() => deleteNode(openPanelNode.id)}
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
                    normalize={normalizeForMerge}
                />
            </Box>
        </>
    )
}

export default Canvas
