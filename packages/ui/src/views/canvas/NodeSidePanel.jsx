import PropTypes from 'prop-types'
import { useEffect, useRef } from 'react'

// material-ui
import { useTheme } from '@mui/material/styles'
import { Box, Divider, IconButton, Typography } from '@mui/material'
import { IconX } from '@tabler/icons-react'

// project imports
import NodeInputHandler from './NodeInputHandler'
import { baseURL } from '@/store/constant'
import { panelSections } from '@/utils/canvasLook'

export const NODE_SIDE_PANEL_WIDTH = 400

// ===========================|| NODE SIDE PANEL ||=========================== //

const NodeSidePanel = ({ node, onClose, readOnly = false }) => {
    const theme = useTheme()
    const panelRef = useRef(null)
    const data = node.data
    const { main, more } = panelSections(data)

    // Move focus into the panel when it opens on a card, so Escape and Tab work from the keyboard.
    useEffect(() => {
        panelRef.current?.focus({ preventScroll: true })
    }, [node.id])

    const onKeyDown = (event) => {
        // Delete and Backspace in the panel edit a field. They never reach the canvas, where they would delete the card.
        if (event.key === 'Delete' || event.key === 'Backspace') event.stopPropagation()
        if (event.key === 'Escape' && !event.defaultPrevented) {
            event.stopPropagation()
            onClose()
        }
    }

    const section = (title) => (
        <>
            <Divider />
            <Box sx={{ background: theme.palette.asyncSelect.main, px: 2, py: 1 }}>
                <Typography sx={{ fontWeight: 500 }}>{title}</Typography>
            </Box>
            <Divider />
        </>
    )

    return (
        <Box
            ref={panelRef}
            tabIndex={-1}
            role='complementary'
            aria-label={`${data.label} settings`}
            data-testid='node-side-panel'
            onKeyDown={onKeyDown}
            sx={{
                width: NODE_SIDE_PANEL_WIDTH,
                flexShrink: 0,
                height: '100%',
                overflowY: 'auto',
                overflowX: 'hidden',
                borderLeft: `1px solid ${theme.palette.divider}`,
                backgroundColor: theme.palette.background.paper,
                outline: 'none'
            }}
        >
            <Box
                sx={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.5,
                    px: 2,
                    py: 1.5,
                    backgroundColor: theme.palette.background.paper,
                    borderBottom: `1px solid ${theme.palette.divider}`
                }}
            >
                <Box
                    sx={{
                        width: 36,
                        height: 36,
                        flexShrink: 0,
                        borderRadius: '50%',
                        backgroundColor: 'white',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                >
                    <img
                        style={{ width: '100%', height: '100%', padding: 5, objectFit: 'contain' }}
                        src={`${baseURL}/api/v1/node-icon/${data.name}`}
                        alt=''
                    />
                </Box>
                <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                    <Typography sx={{ fontSize: '1rem', fontWeight: 500 }} noWrap title={data.label}>
                        {data.label}
                    </Typography>
                    <Typography variant='caption' color='text.secondary' noWrap>
                        {readOnly ? `${data.id}, read only` : data.id}
                    </Typography>
                </Box>
                <IconButton title='Close' aria-label='Close settings' onClick={onClose} size='small'>
                    <IconX size={20} />
                </IconButton>
            </Box>
            {main.length === 0 && more.length === 0 && (
                <Typography sx={{ p: 2 }} color='text.secondary'>
                    This card has no settings. Connect it on the canvas.
                </Typography>
            )}
            {main.length > 0 && section('Settings')}
            {main.map((inputParam) => (
                <NodeInputHandler
                    key={`${node.id}:${inputParam.name}`}
                    inputParam={inputParam}
                    data={data}
                    isAdditionalParams={true}
                    disabled={readOnly}
                />
            ))}
            {more.length > 0 && section('More settings')}
            {more.map((inputParam) => (
                <NodeInputHandler
                    key={`${node.id}:${inputParam.name}`}
                    inputParam={inputParam}
                    data={data}
                    isAdditionalParams={true}
                    disabled={readOnly}
                />
            ))}
        </Box>
    )
}

NodeSidePanel.propTypes = {
    node: PropTypes.object.isRequired,
    onClose: PropTypes.func.isRequired,
    readOnly: PropTypes.bool
}

export default NodeSidePanel
