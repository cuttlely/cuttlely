import PropTypes from 'prop-types'
import { useContext, useState } from 'react'
import { useSelector } from 'react-redux'
import { useEdges } from 'reactflow'

// material-ui
import { styled, useTheme } from '@mui/material/styles'
import { Box, Typography, Divider, Button } from '@mui/material'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import NodeInputHandler from '@/views/canvas/NodeInputHandler'
import NodeOutputHandler from '@/views/canvas/NodeOutputHandler'
import AdditionalParamsDialog from '@/ui-component/dialog/AdditionalParamsDialog'
import CompactCardBody, { COMPACT_CARD_WIDTH } from '@/views/canvas/CompactCardBody'
import CardAccentIcon from '@/views/canvas/CardAccentIcon'
import { useCardHover } from '@/views/canvas/NodeActionBar'
import { CanvasPanelContext } from '@/store/context/CanvasPanelContext'
import { missingNodeInfo } from '@/utils/missingNode'
import MissingNodeCard from '@/views/canvas/MissingNodeCard'
import { cardAccentColor, cardAccentSx } from '@/utils/cardAccent'

// const
import { baseURL } from '@/store/constant'

const CardWrapper = styled(MainCard)(({ theme }) => ({
    background: theme.palette.card.main,
    color: theme.darkTextPrimary,
    border: 'solid 1px',
    borderColor: theme.palette.primary[200] + 75,
    width: '300px',
    height: 'auto',
    padding: '10px',
    boxShadow: '0 2px 14px 0 rgb(32 40 45 / 8%)',
    '&:hover': {
        borderColor: theme.palette.primary.main
    }
}))

// ===========================|| CANVAS NODE ||=========================== //

const MarketplaceCanvasNode = ({ data }) => {
    const theme = useTheme()
    const canvas = useSelector((state) => state.canvas)
    const customization = useSelector((state) => state.customization)
    const edges = useEdges()
    const { compact } = useContext(CanvasPanelContext)
    const { hovered, hoverProps } = useCardHover()
    const node = data || {}
    const [showDialog, setShowDialog] = useState(false)
    const [dialogProps, setDialogProps] = useState({})
    const missing = missingNodeInfo(node, canvas?.componentNodes, canvas?.nodePackIndex)
    if (missing) return <MissingNodeCard data={node} message={missing.message} edges={edges} />
    const inputAnchors = Array.isArray(node.inputAnchors) ? node.inputAnchors : []
    const inputParams = Array.isArray(node.inputParams) ? node.inputParams : []
    const outputAnchors = Array.isArray(node.outputAnchors) ? node.outputAnchors : []

    const onDialogClicked = () => {
        const dialogProps = {
            data: node,
            inputParams: inputParams.filter((param) => param.additionalParams),
            disabled: true,
            confirmButtonName: 'Save',
            cancelButtonName: 'Cancel'
        }
        setDialogProps(dialogProps)
        setShowDialog(true)
    }

    const accent = cardAccentColor(node)

    return (
        <>
            <CardWrapper
                {...hoverProps}
                content={false}
                sx={cardAccentSx(accent, {
                    selected: Boolean(node.selected),
                    hovered,
                    dark: Boolean(customization?.isDarkMode),
                    width: compact ? COMPACT_CARD_WIDTH : undefined
                })}
                border={false}
            >
                <Box>
                    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                        <Box style={{ width: 50, marginRight: 10, padding: 5 }}>
                            <CardAccentIcon
                                name={node.name}
                                color={accent}
                                size={44}
                                src={`${baseURL}/api/v1/node-icon/${node.name || 'unknown'}`}
                            />
                        </Box>
                        <Box>
                            <Typography
                                sx={{
                                    fontSize: '1rem',
                                    fontWeight: 500
                                }}
                            >
                                {node.label}
                            </Typography>
                        </Box>
                        <div style={{ flexGrow: 1 }}></div>
                    </div>
                    {compact && <CompactCardBody data={node} disabled />}
                    {!compact && (
                        <>
                            {(inputAnchors.length > 0 || inputParams.length > 0) && (
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
                            {inputAnchors.map((inputAnchor, index) => (
                                <NodeInputHandler disabled={true} key={index} inputAnchor={inputAnchor} data={node} />
                            ))}
                            {inputParams
                                .filter((inputParam) => inputParam.display !== false)
                                .map((inputParam, index) => (
                                    <NodeInputHandler disabled={true} key={index} inputParam={inputParam} data={node} />
                                ))}
                            {inputParams.find((param) => param.additionalParams) && (
                                <div
                                    style={{
                                        textAlign: 'center',
                                        marginTop:
                                            inputParams.filter((param) => param.additionalParams).length ===
                                            inputParams.length + inputAnchors.length
                                                ? 20
                                                : 0
                                    }}
                                >
                                    <Button sx={{ borderRadius: 25, width: '90%', mb: 2 }} variant='outlined' onClick={onDialogClicked}>
                                        Additional Parameters
                                    </Button>
                                </div>
                            )}
                            <Divider />
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
                            <Divider />

                            {outputAnchors.map((outputAnchor, index) => (
                                <NodeOutputHandler disabled={true} key={index} outputAnchor={outputAnchor} data={node} />
                            ))}
                        </>
                    )}
                </Box>
            </CardWrapper>
            <AdditionalParamsDialog
                show={showDialog}
                dialogProps={dialogProps}
                onCancel={() => setShowDialog(false)}
            ></AdditionalParamsDialog>
        </>
    )
}

MarketplaceCanvasNode.propTypes = {
    data: PropTypes.object
}

export default MarketplaceCanvasNode
