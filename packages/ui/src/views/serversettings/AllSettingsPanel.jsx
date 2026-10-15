import { useState } from 'react'
import PropTypes from 'prop-types'

import { alpha, useTheme } from '@mui/material/styles'
import {
    Box,
    Button,
    Chip,
    Paper,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Typography
} from '@mui/material'
import { IconCheck, IconCopy, IconLock } from '@tabler/icons-react'

import { describeValue, envExport, limitedByLabel, matchesQuery } from './model'

const SOURCE_LABELS = { host: 'Host', file: 'Saved here', panel: 'Saved here', default: 'Default' }

// Every setting in one table, where each value comes from, and what is kept out of the browser and why.
const AllSettingsPanel = ({ settings, sections, keptOut, query, onOpen }) => {
    const theme = useTheme()
    const rows = settings.filter((setting) => matchesQuery(setting, query))
    const sectionLabel = (id) => sections.find((section) => section.id === id)?.label ?? id
    const valueText = (setting) => {
        if (setting.type === 'secret') return setting.secret?.set ? 'Set (hidden)' : 'Not set'
        return describeValue(setting, setting.value)
    }
    const [copied, setCopied] = useState(false)
    const copyEnv = async () => {
        try {
            await globalThis.navigator?.clipboard?.writeText(envExport(settings))
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
        } catch {
            setCopied(false)
        }
    }
    return (
        <Stack gap={4}>
            <Stack direction='row' alignItems='center' justifyContent='space-between' gap={2} sx={{ mb: -2 }}>
                <Typography variant='body2' color='text.secondary'>
                    Copy as .env gives the values saved here, for a .env file or a host&apos;s environment page. Secrets are left out.
                </Typography>
                <Button
                    size='small'
                    variant='outlined'
                    onClick={copyEnv}
                    startIcon={copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
                    sx={{ borderRadius: 2, whiteSpace: 'nowrap', flexShrink: 0, textTransform: 'none' }}
                    data-testid='copy-env'
                >
                    {copied ? 'Copied' : 'Copy as .env'}
                </Button>
            </Stack>
            <TableContainer component={Paper} variant='outlined' sx={{ borderRadius: 3 }}>
                <Table size='small' aria-label='All server settings'>
                    <TableHead>
                        <TableRow sx={{ '& th': { fontWeight: 600, backgroundColor: alpha(theme.palette.text.primary, 0.03) } }}>
                            <TableCell>Setting</TableCell>
                            <TableCell>Section</TableCell>
                            <TableCell>From</TableCell>
                            <TableCell>Value</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map((setting) => (
                            <TableRow
                                key={setting.key}
                                hover
                                onClick={() => onOpen(setting.section, setting.key)}
                                sx={{ cursor: 'pointer', '&:last-child td': { borderBottom: 0 } }}
                            >
                                <TableCell sx={{ py: 1.25 }}>
                                    <Typography variant='body2' sx={{ fontWeight: 500 }}>
                                        {setting.label}
                                    </Typography>
                                    <Typography
                                        variant='caption'
                                        sx={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'text.disabled' }}
                                    >
                                        {setting.key}
                                    </Typography>
                                </TableCell>
                                <TableCell>
                                    <Typography variant='body2' color='text.secondary'>
                                        {sectionLabel(setting.section)}
                                    </Typography>
                                </TableCell>
                                <TableCell>
                                    <Chip
                                        size='small'
                                        icon={setting.locked ? <IconLock size={12} /> : undefined}
                                        label={limitedByLabel(setting) || (SOURCE_LABELS[setting.source] ?? setting.source)}
                                        variant={setting.source === 'default' ? 'outlined' : 'filled'}
                                        color={setting.source === 'file' || setting.source === 'panel' ? 'primary' : 'default'}
                                        sx={{ height: 22, fontSize: '0.72rem', borderRadius: 1.5 }}
                                    />
                                </TableCell>
                                <TableCell sx={{ maxWidth: 320 }}>
                                    <Typography variant='body2' noWrap title={valueText(setting)}>
                                        {valueText(setting)}
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        ))}
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={4}>
                                    <Typography color='text.secondary' sx={{ py: 3, textAlign: 'center' }}>
                                        No setting matches that search.
                                    </Typography>
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </TableContainer>

            <Box>
                <Typography sx={{ fontWeight: 600, fontSize: '1.05rem' }}>Kept out of the browser</Typography>
                <Typography variant='body2' color='text.secondary' sx={{ mt: 0.5, mb: 2 }}>
                    These stay with whoever runs the server. Set them where Cuttlely is installed.
                </Typography>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
                    {keptOut.map((group) => (
                        <Paper key={group.group} variant='outlined' sx={{ p: 2.25, borderRadius: 3 }}>
                            <Stack direction='row' alignItems='center' gap={1}>
                                <IconLock size={16} />
                                <Typography sx={{ fontWeight: 600 }}>{group.group}</Typography>
                            </Stack>
                            <Typography variant='body2' color='text.secondary' sx={{ mt: 0.75 }}>
                                {group.why}
                            </Typography>
                            <Typography
                                variant='caption'
                                sx={{
                                    display: 'block',
                                    mt: 1.25,
                                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                    color: 'text.disabled',
                                    wordBreak: 'break-word'
                                }}
                            >
                                {group.keys.join('  ')}
                            </Typography>
                        </Paper>
                    ))}
                </Box>
            </Box>
        </Stack>
    )
}

AllSettingsPanel.propTypes = {
    settings: PropTypes.array.isRequired,
    sections: PropTypes.array.isRequired,
    keptOut: PropTypes.array.isRequired,
    query: PropTypes.string,
    onOpen: PropTypes.func.isRequired
}

export default AllSettingsPanel
