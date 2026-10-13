import { createPortal } from 'react-dom'
import { useDispatch, useSelector } from 'react-redux'
import { useState, useEffect, useRef, useContext, memo } from 'react'
import { useUpdateNodeInternals } from 'reactflow'
import PropTypes from 'prop-types'
import { Stack, Box, Typography, TextField, Dialog, DialogContent, ButtonBase, Avatar } from '@mui/material'
import NodeInputHandler from '@/views/canvas/NodeInputHandler'
import { HIDE_CANVAS_DIALOG, SHOW_CANVAS_DIALOG } from '@/store/actions'
import { IconPencil, IconX, IconCheck, IconInfoCircle } from '@tabler/icons-react'
import { useTheme } from '@mui/material/styles'
import { flowContext } from '@/store/context/ReactFlowContext'
import { applyVisibleInputDefaults, showHideInputParams } from '@/utils/genericHelper'
import { NODE_SIDE_PANEL_WIDTH } from '@/views/canvas/NodeSidePanel'
import NodePanelHeader from '@/views/canvas/NodePanelHeader'
import { CanvasPanelContext } from '@/store/context/CanvasPanelContext'

// variant 'panel' shows the same settings docked on the right of the canvas (the new card look) instead of in a dialog.
const EditNodeDialog = ({ show, dialogProps, onCancel, variant = 'dialog' }) => {
    const asPanel = variant === 'panel'
    const portalElement = document.getElementById('portal')
    const dispatch = useDispatch()
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const nodeNameRef = useRef()
    const { reactFlowInstance, deleteNode, duplicateNode } = useContext(flowContext)
    const { onDuplicated } = useContext(CanvasPanelContext)
    const updateNodeInternals = useUpdateNodeInternals()

    const [inputParams, setInputParams] = useState([])
    const [data, setData] = useState({})
    const [isEditingNodeName, setEditingNodeName] = useState(null)
    const [nodeName, setNodeName] = useState('')

    const onNodeLabelChange = () => {
        reactFlowInstance.setNodes((nds) =>
            nds.map((node) => {
                if (node.id === data.id) {
                    node.data = {
                        ...node.data,
                        label: nodeNameRef.current.value
                    }
                    setData(node.data)
                }
                return node
            })
        )
        updateNodeInternals(data.id)
    }

    const onCustomDataChange = ({ nodeId, inputParam, newValue }) => {
        reactFlowInstance.setNodes((nds) =>
            nds.map((node) => {
                if (node.id === nodeId) {
                    const updatedInputs = applyVisibleInputDefaults(node.data.inputParams, {
                        ...node.data.inputs,
                        [inputParam.name]: newValue
                    })

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

                    node.data = {
                        ...node.data,
                        inputParams: updatedInputParams,
                        inputs: updatedInputs
                    }

                    setInputParams(updatedInputParams)
                    setData(node.data)
                }
                return node
            })
        )
    }

    useEffect(() => {
        if (dialogProps.inputParams) {
            setInputParams(dialogProps.inputParams)
        }
        if (dialogProps.data) {
            setData(dialogProps.data)
            if (dialogProps.data.label) setNodeName(dialogProps.data.label)
        }

        return () => {
            setInputParams([])
            setData({})
        }
    }, [dialogProps])

    // The dialog stops canvas shortcuts while open. The panel stays open while you work on the canvas, so it only
    // keeps its own Delete and Backspace from reaching the canvas (see onPanelKeyDown).
    useEffect(() => {
        if (asPanel) return
        if (show) dispatch({ type: SHOW_CANVAS_DIALOG })
        else dispatch({ type: HIDE_CANVAS_DIALOG })
        return () => dispatch({ type: HIDE_CANVAS_DIALOG })
    }, [show, dispatch, asPanel])

    const panelRef = useRef(null)
    useEffect(() => {
        if (asPanel && show) panelRef.current?.focus({ preventScroll: true })
    }, [asPanel, show, data?.id])

    const onPanelKeyDown = (event) => {
        if (event.key === 'Delete' || event.key === 'Backspace') event.stopPropagation()
        if (event.key === 'Escape' && !event.defaultPrevented) {
            event.stopPropagation()
            onCancel()
        }
    }

    const content = (
        <>
            {data && data.name && (
                <Box sx={{ width: '100%' }}>
                    {!isEditingNodeName ? (
                        <Stack flexDirection='row' sx={{ display: 'flex', alignItems: 'center', mb: 2 }}>
                            <Typography
                                sx={{
                                    ml: 2,
                                    textOverflow: 'ellipsis',
                                    overflow: 'hidden',
                                    whiteSpace: 'nowrap'
                                }}
                                variant='h4'
                            >
                                {nodeName}
                            </Typography>

                            {data?.id && (
                                <ButtonBase title='Edit Name' sx={{ borderRadius: '50%' }}>
                                    <Avatar
                                        variant='rounded'
                                        sx={{
                                            ...theme.typography.commonAvatar,
                                            ...theme.typography.mediumAvatar,
                                            transition: 'all .2s ease-in-out',
                                            ml: 1,
                                            background: theme.palette.secondary.light,
                                            color: theme.palette.secondary.dark,
                                            '&:hover': {
                                                background: theme.palette.secondary.dark,
                                                color: theme.palette.secondary.light
                                            }
                                        }}
                                        color='inherit'
                                        onClick={() => setEditingNodeName(true)}
                                    >
                                        <IconPencil stroke={1.5} size='1rem' />
                                    </Avatar>
                                </ButtonBase>
                            )}
                        </Stack>
                    ) : (
                        <Stack flexDirection='row' sx={{ width: '100%' }}>
                            <TextField
                                //eslint-disable-next-line jsx-a11y/no-autofocus
                                autoFocus
                                size='small'
                                sx={{
                                    width: '100%',
                                    ml: 2
                                }}
                                inputRef={nodeNameRef}
                                defaultValue={nodeName}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        data.label = nodeNameRef.current.value
                                        setNodeName(nodeNameRef.current.value)
                                        onNodeLabelChange()
                                        setEditingNodeName(false)
                                    } else if (e.key === 'Escape') {
                                        setEditingNodeName(false)
                                    }
                                }}
                            />
                            <ButtonBase title='Save Name' sx={{ borderRadius: '50%' }}>
                                <Avatar
                                    variant='rounded'
                                    sx={{
                                        ...theme.typography.commonAvatar,
                                        ...theme.typography.mediumAvatar,
                                        transition: 'all .2s ease-in-out',
                                        background: theme.palette.success.light,
                                        color: theme.palette.success.dark,
                                        ml: 1,
                                        '&:hover': {
                                            background: theme.palette.success.dark,
                                            color: theme.palette.success.light
                                        }
                                    }}
                                    color='inherit'
                                    onClick={() => {
                                        data.label = nodeNameRef.current.value
                                        setNodeName(nodeNameRef.current.value)
                                        onNodeLabelChange()
                                        setEditingNodeName(false)
                                    }}
                                >
                                    <IconCheck stroke={1.5} size='1rem' />
                                </Avatar>
                            </ButtonBase>
                            <ButtonBase title='Cancel' sx={{ borderRadius: '50%' }}>
                                <Avatar
                                    variant='rounded'
                                    sx={{
                                        ...theme.typography.commonAvatar,
                                        ...theme.typography.mediumAvatar,
                                        transition: 'all .2s ease-in-out',
                                        background: theme.palette.error.light,
                                        color: theme.palette.error.dark,
                                        ml: 1,
                                        '&:hover': {
                                            background: theme.palette.error.dark,
                                            color: theme.palette.error.light
                                        }
                                    }}
                                    color='inherit'
                                    onClick={() => setEditingNodeName(false)}
                                >
                                    <IconX stroke={1.5} size='1rem' />
                                </Avatar>
                            </ButtonBase>
                        </Stack>
                    )}
                </Box>
            )}
            {data?.hint && (
                <Stack
                    direction='row'
                    alignItems='center'
                    sx={{
                        ml: 2,
                        backgroundColor: customization.isDarkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.03)',
                        borderRadius: '8px',
                        mr: 2,
                        px: 1.5,
                        py: 1,
                        mt: 1,
                        mb: 1,
                        border: `1px solid ${customization.isDarkMode ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)'}`
                    }}
                >
                    <IconInfoCircle size='1rem' stroke={1.5} color={theme.palette.info.main} style={{ marginRight: '6px' }} />
                    <Typography
                        variant='caption'
                        color='text.secondary'
                        sx={{
                            fontStyle: 'italic',
                            lineHeight: 1.2
                        }}
                    >
                        {data.hint}
                    </Typography>
                </Stack>
            )}
            {inputParams
                .filter((inputParam) => inputParam.display !== false)
                .map((inputParam, index) => (
                    <NodeInputHandler
                        disabled={dialogProps.disabled}
                        key={index}
                        inputParam={inputParam}
                        data={data}
                        isAdditionalParams={true}
                        onCustomDataChange={onCustomDataChange}
                    />
                ))}
        </>
    )

    if (asPanel) {
        if (!show) return null
        return (
            <Box
                ref={panelRef}
                tabIndex={-1}
                role='complementary'
                aria-label={`${nodeName || data?.label || 'Node'} settings`}
                data-testid='node-side-panel'
                onKeyDown={onPanelKeyDown}
                sx={{
                    width: NODE_SIDE_PANEL_WIDTH,
                    flexShrink: 0,
                    height: '100%',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    borderLeft: `1px solid ${theme.palette.divider}`,
                    backgroundColor: theme.palette.background.paper,
                    outline: 'none',
                    position: 'relative',
                    pt: 1.5,
                    pr: 1
                }}
            >
                <NodePanelHeader
                    nodeName={data?.name}
                    readOnly={Boolean(dialogProps.disabled)}
                    onClose={onCancel}
                    onDuplicate={() => {
                        const created = duplicateNode(data.id)
                        if (created?.id) onDuplicated(created)
                    }}
                    onDelete={() => {
                        deleteNode(data.id)
                        onCancel()
                    }}
                >
                    <span />
                </NodePanelHeader>
                <Box>{content}</Box>
            </Box>
        )
    }

    const component = show ? (
        <Dialog
            onClose={onCancel}
            open={show}
            fullWidth
            maxWidth='sm'
            aria-labelledby='alert-dialog-title'
            aria-describedby='alert-dialog-description'
        >
            <DialogContent>{content}</DialogContent>
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

EditNodeDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func,
    variant: PropTypes.oneOf(['dialog', 'panel'])
}

export default memo(EditNodeDialog)
