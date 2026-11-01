import PropTypes from 'prop-types'

import { Box, IconButton, Typography } from '@mui/material'
import { IconArrowsMaximize, IconArrowsMinimize, IconCopy, IconTrash, IconX } from '@tabler/icons-react'

import { panelHeaderActions } from './cardActions'

// The close icon uses the theme text color on purpose. The default icon color stays black, so on a dark
// panel the X is darker than the panel and disappears.
const actionButtonSx = {
    color: 'text.primary',
    border: '1px solid',
    borderColor: 'divider',
    bgcolor: 'background.default'
}

const NodePanelHeader = ({
    label,
    subtitle,
    icon,
    nodeName,
    readOnly = false,
    expanded = false,
    onToggleExpand,
    onDuplicate,
    onDelete,
    onClose,
    children
}) => {
    const actions = panelHeaderActions({ nodeName, readOnly })
    return (
        <Box
            sx={{
                position: 'sticky',
                top: 0,
                zIndex: 3,
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 2,
                py: 1.25,
                bgcolor: 'background.paper',
                borderBottom: '1px solid',
                borderColor: 'divider'
            }}
        >
            {icon}
            <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                {children || (
                    <Typography sx={{ fontSize: '1rem', fontWeight: 500 }} noWrap title={label}>
                        {label}
                    </Typography>
                )}
                {subtitle && (
                    <Typography variant='caption' component='div' color='text.secondary' noWrap title={subtitle}>
                        {subtitle}
                    </Typography>
                )}
            </Box>
            {onToggleExpand && (
                <IconButton
                    title={expanded ? 'Restore panel width' : 'Expand panel'}
                    aria-label={expanded ? 'Restore panel width' : 'Expand panel'}
                    aria-pressed={expanded}
                    data-testid='panel-expand'
                    size='small'
                    onClick={onToggleExpand}
                    sx={actionButtonSx}
                >
                    {expanded ? <IconArrowsMinimize size={18} /> : <IconArrowsMaximize size={18} />}
                </IconButton>
            )}
            {actions.duplicate && (
                <IconButton
                    title='Duplicate'
                    aria-label='Duplicate'
                    data-testid='panel-duplicate'
                    size='small'
                    onClick={onDuplicate}
                    sx={actionButtonSx}
                >
                    <IconCopy size={18} />
                </IconButton>
            )}
            {actions.delete && (
                <IconButton
                    title='Delete'
                    aria-label='Delete'
                    data-testid='panel-delete'
                    size='small'
                    onClick={onDelete}
                    sx={actionButtonSx}
                >
                    <IconTrash size={18} />
                </IconButton>
            )}
            {actions.close && (
                <IconButton
                    title='Close'
                    aria-label='Close settings'
                    data-testid='close-settings'
                    size='small'
                    onClick={onClose}
                    sx={actionButtonSx}
                >
                    <IconX size={20} />
                </IconButton>
            )}
        </Box>
    )
}

NodePanelHeader.propTypes = {
    label: PropTypes.string,
    subtitle: PropTypes.string,
    icon: PropTypes.node,
    nodeName: PropTypes.string,
    readOnly: PropTypes.bool,
    expanded: PropTypes.bool,
    onToggleExpand: PropTypes.func,
    onDuplicate: PropTypes.func,
    onDelete: PropTypes.func,
    onClose: PropTypes.func,
    children: PropTypes.node
}

export default NodePanelHeader
