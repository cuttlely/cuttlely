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
import AddNodes from '@/views/canvas/AddNodes'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import EditNodeDialog from '@/views/agentflowsv2/EditNodeDialog'
import ChatPopUp from '@/views/chatmessage/ChatPopUp'
import ScheduleHistoryFAB from '@/views/schedule/ScheduleHistoryFAB'
import WebhookListenerFAB from '@/views/webhooklistener/WebhookListenerFAB'
import ValidationPopUp from '@/views/chatmessage/ValidationPopUp'
import { flowContext } from '@/store/context/ReactFlowContext'

// API
import nodesApi from '@/api/nodes'
import chatflowsApi from '@/api/chatflows'
import flowDraftsApi from '@/api/flowDrafts'

// Hooks
import useApi from '@/hooks/useApi'
import useConfirm from '@/hooks/useConfirm'
import useCanvasLook from '@/hooks/useCanvasLook'
import { isNewLook, panelNode } from '@/utils/canvasLook'

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
import useNotifier from '@/utils/useNotifier'
import { usePrompt } from '@/utils/usePrompt'
import { apiErrorMessage, canvasFlowText, planCanvasSave } from '@/utils/flowDrafts'
import { canvasSaveDocument } from '@/utils/canvasSave'
import { canvasIsEmpty, missingCredentialsText, stashNewCanvas, takeLanding, withStarterQuestions } from '@/utils/buildWithAI'
import BuildLandingDialog from '@/ui-component/dialog/BuildLandingDialog'

// const
import { AGENTFLOW_ICONS, uiBaseURL } from '@/store/constant'

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
    const [canvasDataStore, setCanvasDataStore] = useState(canvas)
    const [chatflow, setChatflow] = useState(null)
    const [draftStatus, setDraftStatusState] = useState(null)
    const draftStatusRef = useRef(null)
    const setDraftStatus = (status) => {
        draftStatusRef.current = status
        setDraftStatusState(status)
    }
    const { reactFlowInstance, setReactFlowInstance } = useContext(flowContext)
    // Build with AI: starter questions wait here until the first save puts them in the chat settings.
    const builderStartersRef = useRef([])
    const [builtResult, setBuiltResult] = useState(null)

    // ==============================|| Snackbar ||============================== //

    useNotifier()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    // ==============================|| ReactFlow ||============================== //

    const [nodes, setNodes, onNodesChange] = useNodesState()
    // New look: a click on a card opens its settings in a side panel instead of the dialog.
    const [canvasLook, setCanvasLook] = useCanvasLook()
    const newLook = isNewLook(canvasLook)
    const [panelNodeId, setPanelNodeId] = useState(null)
    const [panelProps, setPanelProps] = useState({})
    const [edges, setEdges, onEdgesChange] = useEdgesState()

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
    const createNewChatflowApi = useApi(chatflowsApi.createNewChatflow)
    const updateChatflowApi = useApi(chatflowsApi.updateChatflow)
    const getSpecificChatflowApi = useApi(chatflowsApi.getSpecificChatflow)

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
            const nodes = graph.nodes || []

            setNodes(nodes)
            setEdges(graph.edges || [])
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

    const handleSaveFlow = async (chatflowName) => {
        if (reactFlowInstance) {
            const rfInstanceObject = canvasSaveDocument(reactFlowInstance, { workflow: true })
            const flowData = JSON.stringify(rfInstanceObject)

            if (!chatflow.id) {
                const newChatflowBody = {
                    name: chatflowName,
                    deployed: false,
                    isPublic: false,
                    flowData,
                    type: 'AGENTFLOW'
                }
                const chatbotConfig = withStarterQuestions(undefined, builderStartersRef.current)
                if (chatbotConfig) newChatflowBody.chatbotConfig = chatbotConfig
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
                        const res = await flowDraftsApi.saveDraft(chatflow.id, plan.draft.flowData)
                        setDraftStatus(res.data)
                        saveBuilderStarters(chatflow)
                    } catch (error) {
                        errorFailed(apiErrorMessage(error, 'Save failed'))
                        return
                    }
                }
                if (plan.live?.flowData) {
                    updateChatflowApi.request(chatflow.id, { name: plan.live.name, flowData: plan.live.flowData })
                    return
                }
                if (plan.live?.name) {
                    try {
                        const res = await chatflowsApi.updateChatflow(chatflow.id, { name: plan.live.name })
                        dispatch({ type: SET_CHATFLOW, chatflow: res.data })
                    } catch (error) {
                        errorFailed(apiErrorMessage(error, 'Save failed'))
                        return
                    }
                }
                if (plan.draft) saveChatflowSuccess('Draft saved')
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
            if (componentNode && componentNode.version > node.data.version) {
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

    // Build with AI: starter questions join the chat settings on the first save of a flow that has none.
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

    const checkIfSyncNodesAvailable = (nodes) => {
        const componentNodes = canvas.componentNodes

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i]
            const componentNode = componentNodes.find((cn) => cn.name === node.data.name)
            if (componentNode && componentNode.version > node.data.version) {
                setIsSyncNodesButtonEnabled(true)
                return
            }
        }

        setIsSyncNodesButtonEnabled(false)
    }

    // ==============================|| useEffect ||============================== //

    const readGraph = (text) => {
        if (!text) return { nodes: [], edges: [] }
        const parsed = JSON.parse(text)
        return { nodes: parsed.nodes || [], edges: parsed.edges || [] }
    }

    const applyCanvasText = (text) => {
        try {
            const flow = readGraph(text)
            setNodes(flow.nodes)
            setEdges(flow.edges)
        } catch {
            setNodes([])
            setEdges([])
        }
        dispatch({ type: REMOVE_DIRTY })
    }

    // Get specific chatflow successful
    useEffect(() => {
        if (getSpecificChatflowApi.data) {
            const loaded = getSpecificChatflowApi.data
            let cancelled = false
            const paint = (status) => {
                if (cancelled) return
                setDraftStatus(status)
                const text = canvasFlowText(loaded, status)
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
            }
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

    // Create new chatflow successful
    useEffect(() => {
        if (createNewChatflowApi.data) {
            const chatflow = createNewChatflowApi.data
            builderStartersRef.current = []
            dispatch({ type: SET_CHATFLOW, chatflow })
            saveChatflowSuccess()
            flowDraftsApi
                .getStatus(chatflow.id)
                .then((res) => setDraftStatus(res.data))
                .catch(() => undefined)
            window.history.replaceState(state, null, `/v2/agentcanvas/${chatflow.id}`)
        } else if (createNewChatflowApi.error) {
            errorFailed(`Failed to save ${canvasTitle}: ${createNewChatflowApi.error.response.data.message}`)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [createNewChatflowApi.data, createNewChatflowApi.error])

    // Update chatflow successful
    useEffect(() => {
        if (updateChatflowApi.data) {
            dispatch({ type: SET_CHATFLOW, chatflow: updateChatflowApi.data })
            saveChatflowSuccess()
            saveBuilderStarters(updateChatflowApi.data)
        } else if (updateChatflowApi.error) {
            errorFailed(`Failed to save ${canvasTitle}: ${updateChatflowApi.error.response.data.message}`)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [updateChatflowApi.data, updateChatflowApi.error])

    useEffect(() => {
        setChatflow(canvasDataStore.chatflow)
        if (canvasDataStore.chatflow) {
            const flowData = canvasDataStore.chatflow.flowData ? JSON.parse(canvasDataStore.chatflow.flowData) : []
            checkIfSyncNodesAvailable(flowData.nodes || [])
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvasDataStore.chatflow])

    // Initialization
    useEffect(() => {
        setIsSyncNodesButtonEnabled(false)
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

    useEffect(() => {
        if (templateFlowData && templateFlowData.includes('"nodes":[') && templateFlowData.includes('],"edges":[')) {
            handleLoadFlow(templateFlowData)
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
    const panelOpen = Boolean(panelNode(nodes, newLook ? panelNodeId : null))

    return (
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
                        />
                    </Toolbar>
                </AppBar>
                <Box sx={{ pt: { xs: '120px', md: '70px' }, height: '100vh', width: '100%' }}>
                    <ReactFlowProvider>
                        <div className='reactflow-parent-wrapper'>
                            <div className='reactflow-wrapper' ref={reactFlowWrapper}>
                                <ReactFlow
                                    nodes={nodes}
                                    edges={edges}
                                    onNodesChange={onNodesChange}
                                    onNodeClick={onNodeClick}
                                    onNodeDoubleClick={onNodeDoubleClick}
                                    onPaneClick={() => setPanelNodeId(null)}
                                    onEdgesChange={onEdgesChange}
                                    onDrop={onDrop}
                                    onDragOver={onDragOver}
                                    onNodeDragStop={setDirty}
                                    nodeTypes={nodeTypes}
                                    edgeTypes={edgeTypes}
                                    onConnect={onConnect}
                                    onInit={setReactFlowInstance}
                                    fitView
                                    deleteKeyCode={canvas.canvasDialogShow ? null : ['Delete']}
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
                    </ReactFlowProvider>
                </Box>
                <ConfirmDialog />
            </Box>
        </>
    )
}

export default AgentflowCanvas
