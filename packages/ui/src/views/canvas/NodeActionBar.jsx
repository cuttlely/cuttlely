import PropTypes from 'prop-types'
import { useContext, useState } from 'react'

import { Box, IconButton } from '@mui/material'
import { IconCopy, IconInfoCircle, IconTrash } from '@tabler/icons-react'

import { flowContext } from '@/store/context/ReactFlowContext'
import { CanvasPanelContext } from '@/store/context/CanvasPanelContext'
import { cardActionNames, showCardActions } from './cardActions'

// The bar sits on the card, above it, on hover and while the card is selected. It is not a tooltip, so it
// stays put when the settings panel is open and it is not turned off by the dialog flag that blocks canvas shortcuts.
const NodeActionBar = ({ data, hovered = false, selected = false, includeInfo = true, onInfo }) => {
    const { deleteNode, duplicateNode, readOnly } = useContext(flowContext)
    const { onDuplicated } = useContext(CanvasPanelContext)
    if (!showCardActions({ hovered, selected, readOnly })) return null
    const names = cardActionNames({ nodeName: data?.name, readOnly, includeInfo })
    if (names.length === 0) return null

    const copy = () => {
        const created = duplicateNode(data.id)
        if (created?.id) onDuplicated(created)
    }

    return (
        <Box
            className='nodrag nopan'
            data-testid='card-actions'
            onClick={(event) => event.stopPropagation()}
            sx={{
                position: 'absolute',
                zIndex: 5,
                top: 0,
                left: '50%',
                transform: 'translate(-50%, -110%)',
                display: 'flex',
                gap: 0.25,
                p: 0.25,
                borderRadius: 1,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.paper',
                color: 'text.primary'
            }}
        >
            {names.includes('duplicate') && (
                <IconButton
                    title='Duplicate'
                    aria-label='Duplicate'
                    data-testid='card-duplicate'
                    size='small'
                    onClick={copy}
                    sx={{ color: 'inherit' }}
                >
                    <IconCopy size={18} />
                </IconButton>
            )}
            {names.includes('delete') && (
                <IconButton
                    title='Delete'
                    aria-label='Delete'
                    data-testid='card-delete'
                    size='small'
                    onClick={() => deleteNode(data.id)}
                    sx={{ color: 'inherit' }}
                >
                    <IconTrash size={18} />
                </IconButton>
            )}
            {names.includes('info') && (
                <IconButton
                    title='Info'
                    aria-label='Info'
                    data-testid='card-info'
                    size='small'
                    onClick={() => onInfo?.()}
                    sx={{ color: 'inherit' }}
                >
                    <IconInfoCircle size={18} />
                </IconButton>
            )}
        </Box>
    )
}

NodeActionBar.propTypes = {
    data: PropTypes.object,
    hovered: PropTypes.bool,
    selected: PropTypes.bool,
    includeInfo: PropTypes.bool,
    onInfo: PropTypes.func
}

// Hover on the card, including the bar above it. The bar is a child, so moving onto it does not count as leaving.
export function useCardHover() {
    const [hovered, setHovered] = useState(false)
    return {
        hovered,
        hoverProps: {
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false)
        }
    }
}

export default NodeActionBar
