import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import ReactFlow, { Controls, Background, ReactFlowProvider, useNodesState, useEdgesState } from 'reactflow'
import 'reactflow/dist/style.css'
import '@/views/canvas/index.css'

import { useLocation, useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import { SET_COMPONENT_NODES, SET_NODE_PACK_INDEX } from '@/store/actions'
import nodesApi from '@/api/nodes'
import useApi from '@/hooks/useApi'

// material-ui
import { Toolbar, Box, AppBar } from '@mui/material'
import { useTheme } from '@mui/material/styles'

// project imports
import MarketplaceCanvasNode from './MarketplaceCanvasNode'
import MarketplaceCanvasHeader from './MarketplaceCanvasHeader'
import StickyNote from '../canvas/StickyNote'
import NodeSidePanel from '../canvas/NodeSidePanel'
import useCanvasLook from '@/hooks/useCanvasLook'
import { CanvasPanelContext } from '@/store/context/CanvasPanelContext'
import { flowContext } from '@/store/context/ReactFlowContext'
import { isNewLook, panelNode } from '@/utils/canvasLook'
import { isLegacyTemplate } from '@/utils/legacyAgentflows'
import { templatePreviewProps } from './templatePreview'

// icons
import {
    IconMagnetFilled,
    IconMagnetOff,
    IconArtboard,
    IconArtboardOff,
    IconLayoutSidebarRight,
    IconLayoutSidebarRightFilled
} from '@tabler/icons-react'

const nodeTypes = { customNode: MarketplaceCanvasNode, stickyNote: StickyNote }
const edgeTypes = { buttonedge: '' }

// ==============================|| CANVAS ||============================== //

const MarketplaceCanvas = () => {
    const theme = useTheme()
    const navigate = useNavigate()
    const dispatch = useDispatch()
    const customization = useSelector((state) => state.customization)
    const getNodesApi = useApi(nodesApi.getAllNodes)
    const getPackIndexApi = useApi(nodesApi.getNodePackIndex)

    const { state } = useLocation()
    const flowData = state?.flowData
    const name = state?.name
    const type = state?.type

    // ==============================|| ReactFlow ||============================== //

    const [nodes, setNodes, onNodesChange] = useNodesState([])
    const [edges, setEdges, onEdgesChange] = useEdgesState([])
    const [isSnappingEnabled, setIsSnappingEnabled] = useState(false)
    const [isBackgroundEnabled, setIsBackgroundEnabled] = useState(true)

    const reactFlowWrapper = useRef(null)

    // New look: compact cards, and a click on a card shows its settings, read only, in a side panel.
    const [canvasLook, setCanvasLook] = useCanvasLook()
    const newLook = isNewLook(canvasLook)
    const [panelNodeId, setPanelNodeId] = useState(null)
    const openPanelNode = panelNode(nodes, newLook ? panelNodeId : null)
    const openPanelNodeId = openPanelNode?.id ?? null
    const panelContext = useMemo(() => ({ panelNodeId: openPanelNodeId, compact: newLook }), [openPanelNodeId, newLook])
    const parentFlow = useContext(flowContext)
    const readOnlyFlow = useMemo(() => ({ ...parentFlow, readOnly: true, deleteNode: () => {}, duplicateNode: () => {} }), [parentFlow])

    // ==============================|| useEffect ||============================== //

    const parsedFlow = (() => {
        if (typeof flowData !== 'string' || !flowData) return { nodes: [], edges: [] }
        try {
            const initialFlow = JSON.parse(flowData)
            const nodes = Array.isArray(initialFlow?.nodes) ? initialFlow.nodes : []
            const edges = Array.isArray(initialFlow?.edges) ? initialFlow.edges : []
            return { ...(initialFlow && typeof initialFlow === 'object' ? initialFlow : {}), nodes, edges }
        } catch {
            return { nodes: [], edges: [] }
        }
    })()

    useEffect(() => {
        setNodes(parsedFlow.nodes)
        setEdges(parsedFlow.edges)

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flowData])

    useEffect(() => {
        getNodesApi.request()
        getPackIndexApi.request()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (Array.isArray(getNodesApi.data)) dispatch({ type: SET_COMPONENT_NODES, componentNodes: getNodesApi.data })
    }, [getNodesApi.data, dispatch])

    useEffect(() => {
        const rows = getPackIndexApi.data?.nodes
        if (Array.isArray(rows)) dispatch({ type: SET_NODE_PACK_INDEX, nodePackIndex: rows })
    }, [getPackIndexApi.data, dispatch])

    // Legacy agentflow (V1) templates are preview only, so no new legacy flow is made from them.
    const legacy = isLegacyTemplate({ type, flowData: parsedFlow })

    const onChatflowCopy = (flowData) => {
        if (legacy) return
        const isAgentCanvas = (flowData?.nodes || []).some(
            (node) => node.data.category === 'Multi Agents' || node.data.category === 'Sequential Agents'
        )
        const templateFlowData = JSON.stringify(flowData)
        const canvas = type === 'Harness' ? 'harnesscanvas' : type === 'ETL' ? 'etlcanvas' : isAgentCanvas ? 'agentcanvas' : 'canvas'
        navigate(`/${canvas}`, { state: { templateFlowData } })
    }

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
                    <Toolbar>
                        <MarketplaceCanvasHeader
                            flowName={name}
                            flowData={parsedFlow}
                            legacy={legacy}
                            templateType={type}
                            onChatflowCopy={(nextFlow) => onChatflowCopy(nextFlow)}
                        />
                    </Toolbar>
                </AppBar>
                <Box sx={{ pt: '70px', height: '100vh', width: '100%' }}>
                    <ReactFlowProvider>
                        <flowContext.Provider value={readOnlyFlow}>
                            <CanvasPanelContext.Provider value={panelContext}>
                                <div className='reactflow-parent-wrapper'>
                                    <div className='reactflow-wrapper' ref={reactFlowWrapper}>
                                        <ReactFlow
                                            nodes={nodes}
                                            edges={edges}
                                            onNodesChange={onNodesChange}
                                            onEdgesChange={onEdgesChange}
                                            nodesDraggable={false}
                                            {...templatePreviewProps}
                                            onNodeClick={(event, node) => setPanelNodeId(node.type === 'stickyNote' ? null : node.id)}
                                            onPaneClick={() => setPanelNodeId(null)}
                                            nodeTypes={nodeTypes}
                                            edgeTypes={edgeTypes}
                                            fitView
                                            minZoom={0.1}
                                            snapGrid={[25, 25]}
                                            snapToGrid={isSnappingEnabled}
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
                                                            ? 'New card look (compact cards, settings in a side panel): on'
                                                            : 'New card look (compact cards, settings in a side panel): off'
                                                    }
                                                    aria-label='toggle side panel'
                                                    aria-pressed={newLook}
                                                >
                                                    {newLook ? <IconLayoutSidebarRightFilled /> : <IconLayoutSidebarRight />}
                                                </button>
                                            </Controls>
                                            {isBackgroundEnabled && <Background color='#aaa' gap={16} />}
                                        </ReactFlow>
                                    </div>
                                    {openPanelNode && <NodeSidePanel node={openPanelNode} onClose={() => setPanelNodeId(null)} readOnly />}
                                </div>
                            </CanvasPanelContext.Provider>
                        </flowContext.Provider>
                    </ReactFlowProvider>
                </Box>
            </Box>
        </>
    )
}

export default MarketplaceCanvas
