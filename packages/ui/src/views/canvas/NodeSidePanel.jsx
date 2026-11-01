import PropTypes from 'prop-types'
import { useEffect, useRef } from 'react'

// material-ui
import { useTheme } from '@mui/material/styles'
import { Box, Divider, Typography } from '@mui/material'

// project imports
import NodeInputHandler from './NodeInputHandler'
import NodePanelHeader from './NodePanelHeader'
import { PanelResizeHandle, useNodePanelWidth } from './NodePanelResize'
import { baseURL } from '@/store/constant'
import { panelSections } from '@/utils/canvasLook'

export { PANEL_DEFAULT_WIDTH as NODE_SIDE_PANEL_WIDTH } from '@/utils/nodePanelWidth'

// ===========================|| NODE SIDE PANEL ||=========================== //

const NodeSidePanel = ({ node, onClose, onDuplicate, onDelete, readOnly = false }) => {
    const theme = useTheme()
    const panelRef = useRef(null)
    const data = node.data
    const { main, more } = panelSections(data)
    const locked = readOnly || !onDelete
    const size = useNodePanelWidth()

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
            data-expanded={size.expanded ? 'true' : 'false'}
            onKeyDown={onKeyDown}
            sx={{
                ...size.widthSx,
                position: 'relative',
                display: 'flex',
                flexShrink: 0,
                height: '100%',
                overflow: 'hidden',
                borderLeft: `1px solid ${theme.palette.divider}`,
                backgroundColor: theme.palette.background.paper,
                outline: 'none'
            }}
        >
            <PanelResizeHandle width={size.width} onPreview={size.setWidth} onCommit={size.commit} hidden={size.expanded} />
            <Box sx={{ flexGrow: 1, minWidth: 0, height: '100%', overflowY: 'auto', overflowX: 'hidden' }}>
                <NodePanelHeader
                    label={data.label}
                    subtitle={locked ? `${data.id}, read only` : data.id}
                    nodeName={data.name}
                    readOnly={locked}
                    onDuplicate={onDuplicate}
                    onDelete={() => {
                        onDelete()
                        onClose()
                    }}
                    onClose={onClose}
                    expanded={size.expanded}
                    onToggleExpand={size.toggleExpanded}
                    icon={
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
                    }
                />
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
        </Box>
    )
}

NodeSidePanel.propTypes = {
    node: PropTypes.object.isRequired,
    onClose: PropTypes.func.isRequired,
    onDuplicate: PropTypes.func,
    onDelete: PropTypes.func,
    readOnly: PropTypes.bool
}

export default NodeSidePanel
