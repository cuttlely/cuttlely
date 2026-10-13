import PropTypes from 'prop-types'
import { useContext, useState, useEffect, memo } from 'react'
import { useSelector } from 'react-redux'
import { useEdges } from 'reactflow'

// material-ui
import { useTheme } from '@mui/material/styles'
import { IconButton, Box, Typography, Divider, Button } from '@mui/material'
import Tooltip from '@mui/material/Tooltip'

// project imports
import NodeCardWrapper from '@/ui-component/cards/NodeCardWrapper'
import NodeActionBar, { useCardHover } from './NodeActionBar'
import NodeInputHandler from './NodeInputHandler'
import NodeOutputHandler from './NodeOutputHandler'
import CompactCardBody, { COMPACT_CARD_WIDTH } from './CompactCardBody'
import AdditionalParamsDialog from '@/ui-component/dialog/AdditionalParamsDialog'
import NodeInfoDialog from '@/ui-component/dialog/NodeInfoDialog'

// const
import { IconAlertTriangle } from '@tabler/icons-react'
import { normalizeNodeData } from '@/utils/normalizeCanvasFlow'
import { missingNodeInfo } from '@/utils/missingNode'
import MissingNodeCard from './MissingNodeCard'
import { canvasOutputKey } from '@/utils/canvasFieldKey'
import { cardPlugParams } from '@/utils/canvasLook'
import { cardAccentColor, cardAccentSx } from '@/utils/cardAccent'
import { CanvasPanelContext } from '@/store/context/CanvasPanelContext'
import CardAccentIcon from './CardAccentIcon'

// ===========================|| CANVAS NODE ||=========================== //

const CanvasNode = ({ data }) => {
    normalizeNodeData(data)
    const theme = useTheme()
    const canvas = useSelector((state) => state.canvas)
    const customization = useSelector((state) => state.customization)
    const { panelNodeId, compact } = useContext(CanvasPanelContext)
    const edges = useEdges()
    const inPanel = panelNodeId === data.id

    const [showDialog, setShowDialog] = useState(false)
    const [dialogProps, setDialogProps] = useState({})
    const [showInfoDialog, setShowInfoDialog] = useState(false)
    const [infoDialogProps, setInfoDialogProps] = useState({})
    const [warningMessage, setWarningMessage] = useState('')
    const [isForceCloseNodeInfo, setIsForceCloseNodeInfo] = useState(null)
    const { hovered, hoverProps } = useCardHover()

    const nodeOutdatedMessage = (oldVersion, newVersion) => `Node version ${oldVersion} outdated\nUpdate to latest version ${newVersion}`

    const nodeVersionEmptyMessage = (newVersion) => `Node outdated\nUpdate to latest version ${newVersion}`

    const onDialogClicked = () => {
        const dialogProps = {
            data,
            inputParams: data.inputParams.filter((inputParam) => !inputParam.hidden).filter((param) => param.additionalParams),
            confirmButtonName: 'Save',
            cancelButtonName: 'Cancel'
        }
        setDialogProps(dialogProps)
        setShowDialog(true)
    }

    useEffect(() => {
        const componentNode = canvas.componentNodes.find((nd) => nd.name === data.name)
        if (componentNode) {
            if (!data.version) {
                setWarningMessage(nodeVersionEmptyMessage(componentNode.version))
            } else if (data.version && componentNode.version > data.version) {
                setWarningMessage(nodeOutdatedMessage(data.version, componentNode.version))
            } else if (componentNode.badge === 'DEPRECATING') {
                setWarningMessage(
                    componentNode?.deprecateMessage ??
                        'This node will be deprecated in the next release. Change to a new node tagged with NEW'
                )
            } else if (componentNode.warning) {
                setWarningMessage(componentNode.warning)
            } else {
                setWarningMessage('')
            }
        }
    }, [canvas.componentNodes, data.name, data.version])

    const missing = missingNodeInfo(data, canvas.componentNodes, canvas.nodePackIndex)
    if (missing) return <MissingNodeCard data={data} message={missing.message} edges={edges} />

    const accent = cardAccentColor(data)

    return (
        <>
            <Box {...hoverProps} sx={{ position: 'relative' }}>
                {!isForceCloseNodeInfo && (
                    <NodeActionBar
                        data={data}
                        hovered={hovered}
                        selected={Boolean(data.selected || inPanel)}
                        onInfo={() => {
                            setInfoDialogProps({ data })
                            setShowInfoDialog(true)
                        }}
                    />
                )}
                <NodeCardWrapper
                    content={false}
                    sx={cardAccentSx(accent, {
                        selected: Boolean(data.selected),
                        hovered,
                        dark: Boolean(customization?.isDarkMode),
                        width: compact ? COMPACT_CARD_WIDTH : undefined
                    })}
                    border={false}
                >
                    <Box>
                        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                            <Box style={{ width: 50, marginRight: 10, padding: 10 }}>
                                <CardAccentIcon name={data.name} color={accent} />
                            </Box>
                            <Box>
                                <Typography
                                    sx={{
                                        fontSize: '1rem',
                                        fontWeight: 500,
                                        mr: 2
                                    }}
                                >
                                    {data.label}
                                </Typography>
                            </Box>
                            <div style={{ flexGrow: 1 }}></div>
                            {warningMessage && (
                                <>
                                    <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{warningMessage}</span>} placement='top'>
                                        <IconButton sx={{ height: 35, width: 35 }}>
                                            <IconAlertTriangle size={35} color='orange' />
                                        </IconButton>
                                    </Tooltip>
                                </>
                            )}
                        </div>
                        {compact && <CompactCardBody data={data} />}
                        {!compact && (
                            <div className='nodrag nopan'>
                                {(data.inputAnchors.length > 0 || data.inputParams.length > 0) && (
                                    <>
                                        <Divider />
                                        <Box sx={{ background: theme.palette.asyncSelect.main, p: 1 }}>
                                            <Typography
                                                sx={{
                                                    fontWeight: 500,
                                                    textAlign: 'center'
                                                }}
                                            >
                                                Inputs
                                            </Typography>
                                        </Box>
                                        <Divider />
                                    </>
                                )}
                                {data.inputAnchors.map((inputAnchor, index) => (
                                    <NodeInputHandler key={index} inputAnchor={inputAnchor} data={data} />
                                ))}
                                {inPanel && (
                                    <>
                                        {cardPlugParams(data).map((inputParam) => (
                                            <NodeInputHandler key={inputParam.id || inputParam.name} inputAnchor={inputParam} data={data} />
                                        ))}
                                        {data.inputParams.some((param) => !param.hidden && param.display !== false) && (
                                            <Typography sx={{ px: 2, py: 1.5, textAlign: 'center' }} color='text.secondary' variant='body2'>
                                                Settings are open in the side panel.
                                            </Typography>
                                        )}
                                    </>
                                )}
                                {!inPanel && (
                                    <>
                                        {data.inputParams
                                            .filter((inputParam) => !inputParam.hidden)
                                            .filter((inputParam) => inputParam.display !== false)
                                            .map((inputParam, index) => (
                                                <NodeInputHandler
                                                    key={index}
                                                    inputParam={inputParam}
                                                    data={data}
                                                    onHideNodeInfoDialog={(status) => {
                                                        if (status) {
                                                            setIsForceCloseNodeInfo(true)
                                                        } else {
                                                            setIsForceCloseNodeInfo(null)
                                                        }
                                                    }}
                                                />
                                            ))}
                                        {data.inputParams.find((param) => param.additionalParams) && (
                                            <div
                                                style={{
                                                    textAlign: 'center',
                                                    marginTop:
                                                        data.inputParams.filter((param) => param.additionalParams).length ===
                                                        data.inputParams.length + data.inputAnchors.length
                                                            ? 20
                                                            : 0
                                                }}
                                            >
                                                <Button
                                                    sx={{ borderRadius: 25, width: '90%', mb: 2 }}
                                                    variant='outlined'
                                                    onClick={onDialogClicked}
                                                >
                                                    Additional Parameters
                                                </Button>
                                            </div>
                                        )}
                                    </>
                                )}
                                {data.outputAnchors.length > 0 && <Divider />}
                                {data.outputAnchors.length > 0 && (
                                    <Box sx={{ background: theme.palette.asyncSelect.main, p: 1 }}>
                                        <Typography
                                            sx={{
                                                fontWeight: 500,
                                                textAlign: 'center'
                                            }}
                                        >
                                            Output
                                        </Typography>
                                    </Box>
                                )}
                                {data.outputAnchors.length > 0 && <Divider />}
                                {data.outputAnchors.length > 0 &&
                                    data.outputAnchors.map((outputAnchor) => (
                                        <NodeOutputHandler
                                            // Plug points are placed when they mount, so they mount again when the card changes height.
                                            key={`${canvasOutputKey(data, outputAnchor)}:${inPanel ? 'panel' : 'card'}`}
                                            outputAnchor={outputAnchor}
                                            data={data}
                                        />
                                    ))}
                            </div>
                        )}
                    </Box>
                </NodeCardWrapper>
            </Box>
            <AdditionalParamsDialog
                show={showDialog}
                dialogProps={dialogProps}
                onCancel={() => setShowDialog(false)}
            ></AdditionalParamsDialog>
            <NodeInfoDialog show={showInfoDialog} dialogProps={infoDialogProps} onCancel={() => setShowInfoDialog(false)}></NodeInfoDialog>
        </>
    )
}

CanvasNode.propTypes = {
    data: PropTypes.object
}

export default memo(CanvasNode)
