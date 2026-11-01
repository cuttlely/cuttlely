import PropTypes from 'prop-types'
import { useState } from 'react'
import { Alert, Box, Button, Divider, Typography } from '@mui/material'

import NodeInputHandler from './NodeInputHandler'
import { MODEL_NOTE, fieldHint, postgresGroups, setCount } from '@/utils/postgresPanel'
import { MODE_TEXT, useAnalystMode } from '@/utils/analystStatus'

// The mode the server would use for this card, read from the server, never guessed from text.
export const ModeBadge = ({ mode, loading, onRetry }) => {
    if (loading) {
        return (
            <Typography variant='caption' color='text.secondary' role='status' sx={{ display: 'block', px: 2, pt: 1 }}>
                Checking where queries go…
            </Typography>
        )
    }
    const text = MODE_TEXT[mode]
    if (!text) return null
    return (
        <Alert
            severity={text.severity}
            variant='outlined'
            role='status'
            data-testid='analyst-mode'
            data-mode={mode}
            sx={{ mx: 2, mt: 1, py: 0 }}
            action={
                (mode === 'unavailable' || mode === 'invalid') && onRetry ? (
                    <Button color='inherit' size='small' onClick={onRetry}>
                        Check again
                    </Button>
                ) : null
            }
        >
            <strong>{text.badge}</strong> {text.detail}
        </Alert>
    )
}

ModeBadge.propTypes = { mode: PropTypes.string, loading: PropTypes.bool, onRetry: PropTypes.func }

const GroupHeader = ({ title, open, onToggle, count, id }) => {
    const folding = typeof onToggle === 'function'
    const text = (
        <Typography variant='overline' sx={{ fontWeight: 600, lineHeight: 1.6 }}>
            {folding ? <span aria-hidden='true'>{open ? '▾ ' : '▸ '}</span> : null}
            {title}
            {!open && count > 0 ? ` · ${count} set` : ''}
        </Typography>
    )
    return (
        <Box sx={{ px: 2, pt: 2, pb: 0.5 }}>
            <Divider sx={{ mb: 1 }} />
            {folding ? (
                <Box
                    component='button'
                    type='button'
                    onClick={onToggle}
                    aria-expanded={open}
                    aria-controls={id}
                    data-testid={`group-${id}`}
                    sx={{
                        all: 'unset',
                        cursor: 'pointer',
                        display: 'block',
                        width: '100%',
                        borderRadius: 1,
                        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
                    }}
                >
                    {text}
                </Box>
            ) : (
                text
            )}
        </Box>
    )
}

GroupHeader.propTypes = {
    title: PropTypes.string,
    open: PropTypes.bool,
    onToggle: PropTypes.func,
    count: PropTypes.number,
    id: PropTypes.string
}

// The Postgres (MCP) card's settings in plain-language groups. The fields are the node's own, saved as before.
const PostgresPanelSections = ({ node, readOnly = false }) => {
    const data = node.data
    // A picked connection is written onto the node data in place, so redraw to re-read it for the badge.
    const [, redraw] = useState(0)
    const { mode, loading, retry } = useAnalystMode(data, true)
    // In sandbox mode the server keeps its own tables, so there is nothing to tick.
    const groups = postgresGroups(data, { hide: mode === 'sandbox' ? ['analystRelations'] : [] })
    const [open, setOpen] = useState(() => Object.fromEntries(groups.map((group) => [group.key, !group.collapsed])))

    return groups.map((group) => {
        const id = `${node.id}-${group.key}`
        const isOpen = open[group.key] !== false
        const toggle = group.collapsed ? () => setOpen((value) => ({ ...value, [group.key]: !isOpen })) : undefined
        return (
            <Box key={group.key} component='section' aria-label={group.title}>
                <GroupHeader title={group.title} open={isOpen} onToggle={toggle} count={setCount(group, data.inputs)} id={id} />
                <Box id={id} hidden={!isOpen}>
                    {group.key === 'source' && <ModeBadge mode={mode} loading={loading} onRetry={retry} />}
                    {group.key === 'see' && mode === 'sandbox' && (
                        <Typography variant='caption' color='text.secondary' sx={{ display: 'block', px: 2, pt: 1 }}>
                            Sandbox: the analyst keeps its own tables, so there are no tables to pick here.
                        </Typography>
                    )}
                    {group.key === 'model' && (
                        <Typography variant='body2' color='text.secondary' sx={{ px: 2, pt: 1 }}>
                            {MODEL_NOTE}
                        </Typography>
                    )}
                    {group.fields.map((field) => {
                        // Sandbox runs without a connection, so the connection is not marked as needed there. Display only.
                        const inputParam = mode === 'sandbox' && field.type === 'credential' ? { ...field, optional: true } : field
                        return (
                            <Box key={`${node.id}:${inputParam.name}`}>
                                <NodeInputHandler
                                    inputParam={inputParam}
                                    data={data}
                                    isAdditionalParams={true}
                                    disabled={readOnly}
                                    onCredentialSelect={() => redraw((value) => value + 1)}
                                />
                                {fieldHint(inputParam.name) && (
                                    <Typography variant='caption' color='text.secondary' sx={{ display: 'block', px: 2, mt: -1, pb: 1 }}>
                                        {fieldHint(inputParam.name)}
                                    </Typography>
                                )}
                            </Box>
                        )
                    })}
                </Box>
            </Box>
        )
    })
}

PostgresPanelSections.propTypes = { node: PropTypes.object.isRequired, readOnly: PropTypes.bool }

export default PostgresPanelSections
