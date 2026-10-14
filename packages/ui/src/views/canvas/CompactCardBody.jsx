import PropTypes from 'prop-types'
import { useSelector } from 'react-redux'

// material-ui
import { Box, Divider, Typography } from '@mui/material'

// project imports
import NodeInputHandler from './NodeInputHandler'
import NodeOutputHandler from './NodeOutputHandler'
import { canvasOutputKey } from '@/utils/canvasFieldKey'
import { cardPlugParams, cardSummary, panelSections } from '@/utils/canvasLook'
import { cardSecondaryText } from '@/utils/cardAccent'

export const COMPACT_CARD_WIDTH = 260

// ===========================|| COMPACT CARD BODY ||=========================== //
// The new card look: connection rows with their plug points, a short summary of what the card is set to, and the
// outputs. The fields themselves open in the side panel. Plug points are the same components, so their ids match the
// classic card's and saved connections land where they did.

const CompactCardBody = ({ data, disabled = false }) => {
    const anchors = Array.isArray(data.inputAnchors) ? data.inputAnchors : []
    const outputs = Array.isArray(data.outputAnchors) ? data.outputAnchors : []
    const plugs = cardPlugParams(data)
    const summary = cardSummary(data)
    const { main, more } = panelSections(data)
    const hasSettings = main.length + more.length > 0
    const summaryColor = cardSecondaryText(useSelector((state) => Boolean(state.customization?.isDarkMode)))

    return (
        <>
            {(anchors.length > 0 || plugs.length > 0) && <Divider />}
            {anchors.map((inputAnchor) => (
                <NodeInputHandler
                    key={inputAnchor.id || inputAnchor.name}
                    inputAnchor={inputAnchor}
                    data={data}
                    disabled={disabled}
                    dense
                />
            ))}
            {plugs.map((inputParam) => (
                <NodeInputHandler key={inputParam.id || inputParam.name} inputAnchor={inputParam} data={data} disabled={disabled} dense />
            ))}
            {hasSettings && (
                <>
                    <Divider />
                    <Box sx={{ px: 2, py: 1 }} data-testid='compact-card-summary'>
                        {summary.map((line) => (
                            <Typography
                                key={line.name}
                                variant='body2'
                                sx={{ color: summaryColor }}
                                noWrap
                                title={`${line.label}: ${line.value}`}
                            >
                                {line.label}: {line.value}
                            </Typography>
                        ))}
                        {summary.length === 0 && (
                            <Typography variant='body2' sx={{ color: summaryColor }}>
                                {disabled ? 'Click to see its settings' : 'Click to edit its settings'}
                            </Typography>
                        )}
                    </Box>
                </>
            )}
            {outputs.length > 0 && <Divider />}
            {outputs.length > 0 && (
                <div className='nodrag nopan'>
                    {outputs.map((outputAnchor) => (
                        <NodeOutputHandler
                            key={`${canvasOutputKey(data, outputAnchor)}:compact`}
                            outputAnchor={outputAnchor}
                            data={data}
                            disabled={disabled}
                            dense
                        />
                    ))}
                </div>
            )}
        </>
    )
}

CompactCardBody.propTypes = {
    data: PropTypes.object.isRequired,
    disabled: PropTypes.bool
}

export default CompactCardBody
