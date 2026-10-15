import PropTypes from 'prop-types'
import { useState } from 'react'

import { alpha, useTheme } from '@mui/material/styles'
import { Box, Button, Chip, InputAdornment, MenuItem, Select, Stack, Switch, TextField, Tooltip, Typography } from '@mui/material'
import { IconArrowBackUp, IconKey, IconLock, IconPointFilled } from '@tabler/icons-react'

import { UNIT_LABELS, currentValue, describeValue, fromDisplay, limitedByLabel, toDisplay } from './model'

const CUSTOM = '__custom__'

// One setting: label, help, its name, and the control. Locked settings show where the value comes from.
const SettingField = ({ setting, drafts, onDraft, error, readOnlyNote }) => {
    const theme = useTheme()
    const edited = Object.prototype.hasOwnProperty.call(drafts, setting.key)
    const value = currentValue(setting, drafts)
    const disabled = setting.locked || Boolean(readOnlyNote)

    return (
        <Box
            data-testid={`setting-${setting.key}`}
            sx={{
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1fr) minmax(260px, 340px)' },
                gap: { xs: 1.5, md: 4 },
                alignItems: 'start',
                px: 3,
                py: 2.25,
                position: 'relative',
                transition: 'background-color 120ms ease',
                backgroundColor: edited ? alpha(theme.palette.primary.main, theme.palette.mode === 'dark' ? 0.1 : 0.04) : 'transparent',
                '&:hover': { backgroundColor: edited ? undefined : alpha(theme.palette.text.primary, 0.02) }
            }}
        >
            {edited && (
                <Box
                    sx={{ position: 'absolute', left: 0, top: 12, bottom: 12, width: 3, borderRadius: 3, backgroundColor: 'primary.main' }}
                />
            )}
            <Box sx={{ minWidth: 0 }}>
                <Stack direction='row' alignItems='center' gap={1} flexWrap='wrap'>
                    <Typography component='label' htmlFor={`field-${setting.key}`} sx={{ fontWeight: 600, fontSize: '0.95rem' }}>
                        {setting.label}
                    </Typography>
                    {limitedByLabel(setting) && (
                        <Chip
                            size='small'
                            label={limitedByLabel(setting)}
                            variant='outlined'
                            data-testid={`bounded-${setting.key}`}
                            sx={{ height: 22, fontSize: '0.72rem', borderRadius: 1.5 }}
                        />
                    )}
                    {setting.locked && (
                        <Tooltip
                            title={`Set outside Cuttlely${
                                setting.hostHint ? ` (${setting.hostHint})` : ''
                            }. Change it there, or remove it there to manage it here.`}
                        >
                            <Chip
                                size='small'
                                icon={<IconLock size={13} />}
                                label='Locked'
                                variant='outlined'
                                sx={{ height: 22, fontSize: '0.72rem', borderRadius: 1.5 }}
                            />
                        </Tooltip>
                    )}
                    {!edited && setting.changed && (
                        <Tooltip title={`Saved. The server is still running with ${describeValue(setting, setting.running)}.`}>
                            <Chip
                                size='small'
                                icon={<IconPointFilled size={12} />}
                                label='Applies at restart'
                                sx={{
                                    height: 22,
                                    fontSize: '0.72rem',
                                    borderRadius: 1.5,
                                    color: theme.palette.warning.dark,
                                    backgroundColor: alpha(theme.palette.warning.main, 0.14),
                                    '& .MuiChip-icon': { color: theme.palette.warning.main }
                                }}
                            />
                        </Tooltip>
                    )}
                    {edited && (
                        <Chip size='small' label='Edited' color='primary' sx={{ height: 22, fontSize: '0.72rem', borderRadius: 1.5 }} />
                    )}
                </Stack>
                <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5, lineHeight: 1.55 }}>
                    {setting.help}
                </Typography>
                <Stack direction='row' alignItems='center' gap={1.5} sx={{ mt: 0.75 }}>
                    <Typography
                        variant='caption'
                        sx={{
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            color: 'text.secondary',
                            opacity: 0.85,
                            letterSpacing: 0.2
                        }}
                    >
                        {setting.key}
                    </Typography>
                    {!setting.locked && !readOnlyNote && setting.type !== 'secret' && value !== '' && (
                        <Button
                            size='small'
                            onClick={() => onDraft(setting.key, '')}
                            startIcon={<IconArrowBackUp size={14} />}
                            sx={{ minWidth: 0, p: 0, px: 0.5, fontSize: '0.75rem', color: 'text.secondary' }}
                        >
                            Use default
                        </Button>
                    )}
                </Stack>
            </Box>
            {/* The control and its helper line: kept clear of the floating save bar when focused. */}
            <Box data-save-bar-clear sx={{ minWidth: 0, scrollMarginBottom: 'var(--cuttlely-save-bar-room, 0px)' }}>
                <Control setting={setting} value={value} edited={edited} disabled={disabled} onDraft={onDraft} error={error} />
                {readOnlyNote && (
                    <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 0.75 }}>
                        {readOnlyNote}
                    </Typography>
                )}
                {!readOnlyNote && !error && (
                    <Typography variant='caption' color='text.secondary' sx={{ display: 'block', mt: 0.75 }}>
                        {setting.type === 'secret' ? null : value === '' ? `Default: ${setting.defaultLabel}` : null}
                    </Typography>
                )}
            </Box>
        </Box>
    )
}

const Control = ({ setting, value, edited, disabled, onDraft, error }) => {
    switch (setting.type) {
        case 'switch':
            return <SwitchControl setting={setting} value={value} disabled={disabled} onDraft={onDraft} />
        case 'select':
            return <SelectControl setting={setting} value={value} disabled={disabled} onDraft={onDraft} error={error} />
        case 'secret':
            return <SecretControl setting={setting} value={value} edited={edited} disabled={disabled} onDraft={onDraft} error={error} />
        case 'number':
            return <NumberControl setting={setting} value={value} disabled={disabled} onDraft={onDraft} error={error} />
        case 'list':
            return <ListControl setting={setting} value={value} disabled={disabled} onDraft={onDraft} error={error} />
        default:
            return (
                <TextField
                    id={`field-${setting.key}`}
                    fullWidth
                    size='small'
                    value={value}
                    disabled={disabled}
                    placeholder={setting.placeholder ?? setting.defaultLabel}
                    onChange={(event) => onDraft(setting.key, event.target.value)}
                    error={Boolean(error)}
                    helperText={error}
                    inputProps={{ spellCheck: false }}
                />
            )
    }
}

const SwitchControl = ({ setting, value, disabled, onDraft }) => {
    const on = setting.on ?? 'true'
    const off = setting.off ?? 'false'
    const effective = value === '' ? setting.defaultValue ?? off : value
    const checked = effective === on
    return (
        <Stack direction='row' alignItems='center' justifyContent={{ xs: 'flex-start', md: 'flex-end' }} gap={1}>
            <Typography variant='body2' color={checked ? 'text.primary' : 'text.secondary'} sx={{ fontWeight: 500 }}>
                {checked ? 'On' : 'Off'}
            </Typography>
            <Switch
                id={`field-${setting.key}`}
                checked={checked}
                disabled={disabled}
                onChange={(event) => onDraft(setting.key, event.target.checked ? on : off)}
                inputProps={{ 'aria-label': setting.label }}
            />
        </Stack>
    )
}

const SelectControl = ({ setting, value, disabled, onDraft, error }) => {
    const options = setting.options ?? []
    const known = value === '' || options.some((option) => option.value === value)
    const [custom, setCustom] = useState(!known)
    const selected = custom ? CUSTOM : value === '' ? '' : value
    return (
        <Stack gap={1}>
            <Select
                id={`field-${setting.key}`}
                size='small'
                fullWidth
                displayEmpty
                value={selected}
                disabled={disabled}
                error={Boolean(error)}
                onChange={(event) => {
                    const next = event.target.value
                    if (next === CUSTOM) {
                        setCustom(true)
                        return
                    }
                    setCustom(false)
                    onDraft(setting.key, next)
                }}
                renderValue={(current) => {
                    if (current === CUSTOM) return setting.custom?.label ?? 'Custom'
                    if (current === '') return <Typography color='text.secondary'>Default ({setting.defaultLabel})</Typography>
                    return options.find((option) => option.value === current)?.label ?? current
                }}
            >
                <MenuItem value=''>
                    <Typography color='text.secondary'>Default ({setting.defaultLabel})</Typography>
                </MenuItem>
                {options
                    .filter((option) => option.value !== '')
                    .map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                            {option.label}
                        </MenuItem>
                    ))}
                {setting.custom && <MenuItem value={CUSTOM}>{setting.custom.label}</MenuItem>}
            </Select>
            {custom && (
                <TextField
                    size='small'
                    fullWidth
                    value={known ? '' : value}
                    placeholder={setting.custom?.placeholder}
                    disabled={disabled}
                    onChange={(event) => onDraft(setting.key, event.target.value)}
                    inputProps={{ spellCheck: false, 'aria-label': `${setting.label}, ${setting.custom?.label ?? 'custom value'}` }}
                />
            )}
            {error && (
                <Typography variant='caption' color='error'>
                    {error}
                </Typography>
            )}
        </Stack>
    )
}

const NumberControl = ({ setting, value, disabled, onDraft, error }) => {
    const unit = setting.unit ? UNIT_LABELS[setting.unit] : ''
    return (
        <TextField
            id={`field-${setting.key}`}
            fullWidth
            size='small'
            type='number'
            value={toDisplay(setting, value)}
            disabled={disabled}
            placeholder={setting.placeholder ?? setting.defaultLabel}
            onChange={(event) => onDraft(setting.key, fromDisplay(setting, event.target.value))}
            error={Boolean(error)}
            helperText={error}
            inputProps={{ min: setting.min, max: setting.max, step: setting.runtime ? '1' : 'any' }}
            InputProps={unit ? { endAdornment: <InputAdornment position='end'>{unit}</InputAdornment> } : undefined}
        />
    )
}

const ListControl = ({ setting, value, disabled, onDraft, error }) => {
    // Stored comma separated, shown one per line. The server tidies spaces and repeats when it saves.
    const items = value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    return (
        <Stack gap={1}>
            <TextField
                id={`field-${setting.key}`}
                fullWidth
                size='small'
                multiline
                minRows={2}
                maxRows={6}
                value={value.split(',').join('\n')}
                disabled={disabled}
                placeholder={setting.placeholder ? `${setting.placeholder}\nOne per line` : 'One per line'}
                onChange={(event) => onDraft(setting.key, event.target.value.split(/\r?\n/).join(','))}
                error={Boolean(error)}
                helperText={error}
                inputProps={{ spellCheck: false }}
            />
            {items.length > 0 && (
                <Stack direction='row' gap={0.75} flexWrap='wrap'>
                    {items.map((item) => (
                        <Chip key={item} size='small' label={item} variant='outlined' sx={{ borderRadius: 1.5, maxWidth: '100%' }} />
                    ))}
                </Stack>
            )}
        </Stack>
    )
}

const SecretControl = ({ setting, value, edited, disabled, onDraft, error }) => {
    const theme = useTheme()
    const set = Boolean(setting.secret?.set)
    const [replacing, setReplacing] = useState(false)
    const removing = edited && value === ''
    if (setting.locked) {
        return <SecretStatus label={set ? 'Set outside Cuttlely' : 'Not set'} tone={set ? 'set' : 'none'} theme={theme} />
    }
    if (replacing || (edited && value !== '') || (!set && !removing)) {
        return (
            <Stack gap={1}>
                <TextField
                    id={`field-${setting.key}`}
                    fullWidth
                    size='small'
                    type='password'
                    autoComplete='new-password'
                    value={edited ? value : ''}
                    placeholder={set ? 'Enter a new value' : setting.placeholder ?? 'Enter a value'}
                    disabled={disabled}
                    onChange={(event) => onDraft(setting.key, event.target.value)}
                    error={Boolean(error)}
                    helperText={error ?? 'Saved encrypted. It is never shown again.'}
                    inputProps={{ spellCheck: false }}
                    InputProps={{
                        startAdornment: (
                            <InputAdornment position='start'>
                                <IconKey size={16} />
                            </InputAdornment>
                        )
                    }}
                />
                {set && (
                    <Button
                        size='small'
                        sx={{ alignSelf: 'flex-start' }}
                        onClick={() => {
                            setReplacing(false)
                            onDraft(setting.key, undefined)
                        }}
                    >
                        Keep the saved value
                    </Button>
                )}
            </Stack>
        )
    }
    return (
        <Stack gap={1}>
            <SecretStatus
                label={removing ? 'Will be removed' : setting.secret?.unreadable ? 'Saved, but this server cannot read it' : 'Set'}
                tone={removing ? 'remove' : setting.secret?.unreadable ? 'warn' : 'set'}
                theme={theme}
            />
            <Stack direction='row' gap={1}>
                {removing ? (
                    <Button size='small' disabled={disabled} onClick={() => onDraft(setting.key, undefined)}>
                        Keep it
                    </Button>
                ) : (
                    <>
                        <Button
                            size='small'
                            variant='outlined'
                            disabled={disabled}
                            onClick={() => setReplacing(true)}
                            sx={{ borderRadius: 2 }}
                        >
                            Replace
                        </Button>
                        <Button size='small' color='error' disabled={disabled} onClick={() => onDraft(setting.key, '')}>
                            Remove
                        </Button>
                    </>
                )}
            </Stack>
        </Stack>
    )
}

const SecretStatus = ({ label, tone, theme }) => {
    const colors = {
        set: theme.palette.success.main,
        warn: theme.palette.warning.main,
        remove: theme.palette.error.main,
        none: theme.palette.text.disabled
    }
    return (
        <Stack
            direction='row'
            alignItems='center'
            gap={1}
            sx={{
                px: 1.5,
                py: 0.9,
                borderRadius: 2,
                border: `1px solid ${theme.palette.divider}`,
                backgroundColor: alpha(colors[tone], 0.06)
            }}
        >
            <IconKey size={16} color={colors[tone]} />
            <Typography variant='body2' sx={{ fontWeight: 500 }}>
                {label}
            </Typography>
            {tone === 'set' && (
                <Typography variant='body2' color='text.disabled' sx={{ ml: 'auto', letterSpacing: 2 }}>
                    ••••••••
                </Typography>
            )}
        </Stack>
    )
}

const settingShape = PropTypes.shape({
    key: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    help: PropTypes.string,
    type: PropTypes.string.isRequired,
    locked: PropTypes.bool,
    source: PropTypes.string,
    boundedBy: PropTypes.string,
    hostHint: PropTypes.string,
    changed: PropTypes.bool,
    running: PropTypes.string,
    defaultLabel: PropTypes.string,
    defaultValue: PropTypes.string,
    on: PropTypes.string,
    off: PropTypes.string,
    options: PropTypes.array,
    custom: PropTypes.object,
    unit: PropTypes.string,
    min: PropTypes.number,
    max: PropTypes.number,
    placeholder: PropTypes.string,
    secret: PropTypes.object
})

SettingField.propTypes = {
    setting: settingShape.isRequired,
    drafts: PropTypes.object.isRequired,
    onDraft: PropTypes.func.isRequired,
    error: PropTypes.string,
    readOnlyNote: PropTypes.string
}
Control.propTypes = {
    setting: settingShape.isRequired,
    value: PropTypes.string,
    edited: PropTypes.bool,
    disabled: PropTypes.bool,
    onDraft: PropTypes.func.isRequired,
    error: PropTypes.string
}
SwitchControl.propTypes = Control.propTypes
SelectControl.propTypes = Control.propTypes
NumberControl.propTypes = Control.propTypes
ListControl.propTypes = Control.propTypes
SecretControl.propTypes = Control.propTypes
SecretStatus.propTypes = { label: PropTypes.string, tone: PropTypes.string, theme: PropTypes.object }

export default SettingField
