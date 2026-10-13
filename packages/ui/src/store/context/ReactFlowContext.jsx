import { createContext, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import PropTypes from 'prop-types'
import { getUniqueNodeId, showHideInputParams } from '@/utils/genericHelper'
import { canvasAfterDelete } from '@/views/canvas/cardActions'
import { cloneDeep, isEqual } from 'lodash'
import { SET_DIRTY } from '@/store/actions'

const initialValue = {
    reactFlowInstance: null,
    setReactFlowInstance: () => {},
    duplicateNode: () => {},
    deleteNode: () => {},
    deleteEdge: () => {},
    onNodeDataChange: () => {}
}

export const flowContext = createContext(initialValue)

export const ReactFlowContext = ({ children }) => {
    const dispatch = useDispatch()
    const [reactFlowInstance, setReactFlowInstance] = useState(null)

    const onAgentflowNodeStatusUpdate = ({ nodeId, status, error }) => {
        reactFlowInstance.setNodes((nds) =>
            nds.map((node) => {
                if (node.id === nodeId) {
                    node.data = {
                        ...node.data,
                        status,
                        error
                    }
                }
                return node
            })
        )
    }

    const clearAgentflowNodeStatus = () => {
        reactFlowInstance.setNodes((nds) =>
            nds.map((node) => {
                node.data = {
                    ...node.data,
                    status: undefined,
                    error: undefined
                }
                return node
            })
        )
    }

    const onNodeDataChange = ({ nodeId, inputParam, newValue }) => {
        const updatedNodes = reactFlowInstance.getNodes().map((node) => {
            if (node.id === nodeId) {
                const updatedInputs = { ...node.data.inputs }

                updatedInputs[inputParam.name] = newValue

                const updatedInputParams = showHideInputParams({
                    ...node.data,
                    inputs: updatedInputs
                })

                // Remove inputs with display set to false
                Object.keys(updatedInputs).forEach((key) => {
                    const input = updatedInputParams.find((param) => param.name === key)
                    if (input && input.display === false) {
                        delete updatedInputs[key]
                    }
                })

                return {
                    ...node,
                    data: {
                        ...node.data,
                        inputParams: updatedInputParams,
                        inputs: updatedInputs
                    }
                }
            }
            return node
        })

        // Check if any node's inputParams have changed before updating
        const hasChanges = updatedNodes.some(
            (node, index) => !isEqual(node.data.inputParams, reactFlowInstance.getNodes()[index].data.inputParams)
        )

        if (hasChanges) {
            reactFlowInstance.setNodes(updatedNodes)
        }
    }

    // React Flow 11 turns setNodes / setEdges into a reset of whatever getNodes() still holds, which is the
    // pre-delete list until this handler returns. The canvas state setters write the cleaned list directly.
    const applyingDelete = useRef(false)
    const commitNodes = useRef(null)
    const commitEdges = useRef(null)
    const bindCanvasState = (setNodes, setEdges) => {
        commitNodes.current = setNodes
        commitEdges.current = setEdges
    }
    // The React setters do not update getNodes or getEdges until the next render. A loop of deleteEdge
    // calls has to see the graph this function just wrote, or every edge but the last comes back.
    const writtenGraph = useRef(null)
    const deleteSelection = ({ nodeIds = [], edgeIds = [] } = {}) => {
        if (!reactFlowInstance) return
        if (!nodeIds.length && !edgeIds.length) return
        const next = canvasAfterDelete({
            nodes: writtenGraph.current ? writtenGraph.current.nodes : reactFlowInstance.getNodes(),
            edges: writtenGraph.current ? writtenGraph.current.edges : reactFlowInstance.getEdges(),
            nodeIds,
            edgeIds
        })
        writtenGraph.current = next
        queueMicrotask(() => {
            if (writtenGraph.current === next) writtenGraph.current = null
        })
        applyingDelete.current = true
        try {
            if (commitNodes.current) commitNodes.current(next.nodes)
            if (commitEdges.current) commitEdges.current(next.edges)
        } finally {
            applyingDelete.current = false
        }
        dispatch({ type: SET_DIRTY })
    }

    const deleteNode = (nodeid) => deleteSelection({ nodeIds: [nodeid] })

    const deleteEdge = (edgeid) => deleteSelection({ edgeIds: [edgeid] })

    const duplicateNode = (id, distance = 50) => {
        const nodes = reactFlowInstance.getNodes()
        const originalNode = nodes.find((n) => n.id === id)
        // The start card of a workflow cannot be copied.
        if (originalNode && originalNode.data?.name !== 'startAgentflow') {
            const newNodeId = getUniqueNodeId(originalNode.data, nodes)
            const clonedNode = cloneDeep(originalNode)

            const duplicatedNode = {
                ...clonedNode,
                id: newNodeId,
                position: {
                    x: clonedNode.position.x + clonedNode.width + distance,
                    y: clonedNode.position.y
                },
                positionAbsolute: {
                    x: clonedNode.positionAbsolute.x + clonedNode.width + distance,
                    y: clonedNode.positionAbsolute.y
                },
                data: {
                    ...clonedNode.data,
                    id: newNodeId,
                    label: clonedNode.data.label + ` (${newNodeId.split('_').pop()})`
                },
                selected: false
            }

            const inputKeys = ['inputParams', 'inputAnchors']
            for (const key of inputKeys) {
                for (const item of duplicatedNode.data[key]) {
                    if (item.id) {
                        item.id = item.id.replace(id, newNodeId)
                    }
                }
            }

            const outputKeys = ['outputAnchors']
            for (const key of outputKeys) {
                for (const item of duplicatedNode.data[key]) {
                    if (item.id) {
                        item.id = item.id.replace(id, newNodeId)
                    }
                    if (item.options) {
                        for (const output of item.options) {
                            output.id = output.id.replace(id, newNodeId)
                        }
                    }
                }
            }

            // Clear connected inputs
            for (const inputName in duplicatedNode.data.inputs) {
                if (
                    typeof duplicatedNode.data.inputs[inputName] === 'string' &&
                    duplicatedNode.data.inputs[inputName].startsWith('{{') &&
                    duplicatedNode.data.inputs[inputName].endsWith('}}')
                ) {
                    duplicatedNode.data.inputs[inputName] = ''
                } else if (Array.isArray(duplicatedNode.data.inputs[inputName])) {
                    duplicatedNode.data.inputs[inputName] = duplicatedNode.data.inputs[inputName].filter(
                        (item) => !(typeof item === 'string' && item.startsWith('{{') && item.endsWith('}}'))
                    )
                }
            }

            duplicatedNode.selected = true
            duplicatedNode.data.selected = true
            // Select the copy so Delete from the keyboard hits the new card, not the one it was copied from.
            const rest = nodes.map((node) => ({
                ...node,
                selected: false,
                data: node.data ? { ...node.data, selected: false } : node.data
            }))
            reactFlowInstance.setNodes([...rest, duplicatedNode])
            dispatch({ type: SET_DIRTY })
            // The id and the card data. The canvas list may not include the copy until the next render.
            return { id: newNodeId, data: duplicatedNode.data }
        }
        return null
    }

    return (
        <flowContext.Provider
            value={{
                reactFlowInstance,
                setReactFlowInstance,
                deleteNode,
                deleteEdge,
                deleteSelection,
                applyingDelete,
                bindCanvasState,
                duplicateNode,
                onAgentflowNodeStatusUpdate,
                clearAgentflowNodeStatus,
                onNodeDataChange
            }}
        >
            {children}
        </flowContext.Provider>
    )
}

ReactFlowContext.propTypes = {
    children: PropTypes.any
}
