import PropTypes from 'prop-types'
import { useEffect } from 'react'
import { Handle, Position, useUpdateNodeInternals } from 'reactflow'

import { Box, Typography } from '@mui/material'
import { placeholderHandles } from '@/utils/missingNode'

const handleTop = (index, count) => `${((index + 1) / (count + 1)) * 100}%`

// A saved node whose class is not loaded. The card names the pack and keeps a handle for every
// saved anchor, so lines into the node stay on the canvas and survive a later save.
const MissingNodeCard = ({ data, message, edges }) => {
    const label = (data && (data.label || data.name)) || 'Node'
    const handles = placeholderHandles(data, edges)
    const handleKey = `${handles.targets.join('|')}::${handles.sources.join('|')}`
    const updateNodeInternals = useUpdateNodeInternals()

    useEffect(() => {
        if (data?.id) updateNodeInternals(data.id)
    }, [data?.id, handleKey, updateNodeInternals])

    return (
        <Box
            data-testid='missing-node-card'
            sx={{
                position: 'relative',
                width: 300,
                p: 2,
                border: '1px solid',
                borderColor: 'divider',
                borderRadius: '8px',
                bgcolor: 'background.paper'
            }}
        >
            {handles.targets.map((id, index) => (
                <Handle key={id} type='target' position={Position.Left} id={id} style={{ top: handleTop(index, handles.targets.length) }} />
            ))}
            {handles.sources.map((id, index) => (
                <Handle
                    key={id}
                    type='source'
                    position={Position.Right}
                    id={id}
                    style={{ top: handleTop(index, handles.sources.length) }}
                />
            ))}
            <Typography sx={{ fontSize: '1rem', fontWeight: 500 }}>{label}</Typography>
            <Typography variant='body2' color='text.secondary' sx={{ mt: 1 }}>
                {message}
            </Typography>
        </Box>
    )
}

MissingNodeCard.propTypes = {
    data: PropTypes.object,
    message: PropTypes.string,
    edges: PropTypes.array
}

export default MissingNodeCard
