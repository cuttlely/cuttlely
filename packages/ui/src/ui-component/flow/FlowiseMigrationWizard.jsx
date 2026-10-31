import { useState } from 'react'
import PropTypes from 'prop-types'

import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Stack,
    Step,
    StepLabel,
    Stepper,
    Typography
} from '@mui/material'

import { flowiseNodeCatalog } from '@/utils/flowiseCatalog'
import { scanFlowiseMigration } from '@/utils/flowiseMigration.mjs'
import { wizardHeal } from '@/utils/edgeRefs'

const STEPS = ['Upload', 'Scan', 'Credentials', 'Nodes', 'Result']

const emptyCopy = {
    credentials: 'No credential slots to reconnect.',
    deprecated: 'No deprecated nodes.',
    unsupported: 'No unsupported nodes.'
}

const ListBlock = ({ items, empty, renderItem }) => {
    if (!items.length) {
        return (
            <Typography variant='body2' color='text.secondary'>
                {empty}
            </Typography>
        )
    }
    return (
        <Box component='ul' sx={{ m: 0, pl: 2.5 }}>
            {items.map((item, index) => (
                <Typography
                    component='li'
                    variant='body2'
                    key={`${item.nodeId || 'node'}-${item.slot || item.name || index}`}
                    sx={{ mt: 0.5 }}
                >
                    {renderItem(item)}
                </Typography>
            ))}
        </Box>
    )
}

ListBlock.propTypes = {
    items: PropTypes.array,
    empty: PropTypes.string,
    renderItem: PropTypes.func
}

const FlowiseMigrationWizard = ({ open, onClose, onOpen, specs, updateNodeData, showHide, catalogPending = false }) => {
    const [step, setStep] = useState(0)
    const [fileName, setFileName] = useState('')
    const [report, setReport] = useState(null)
    const [parseError, setParseError] = useState('')

    const reset = () => {
        setStep(0)
        setFileName('')
        setReport(null)
        setParseError('')
    }

    const close = () => {
        reset()
        onClose()
    }

    const onFile = (event) => {
        if (catalogPending) return
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        setFileName(file.name)
        setParseError('')
        const reader = new FileReader()
        reader.onload = () => {
            let parsed
            try {
                parsed = JSON.parse(String(reader.result || ''))
            } catch {
                setReport(null)
                setParseError('That file is not a Flowise chatflow JSON.')
                setStep(0)
                return
            }
            const next = scanFlowiseMigration(parsed, {
                catalog: flowiseNodeCatalog,
                heal: wizardHeal(specs, { updateNodeData, showHide })
            })
            if (next.code === 'langflow' || next.code === 'not-flowise' || next.code === 'tool') {
                setReport(null)
                setParseError(next.reason)
                setStep(0)
                return
            }
            setReport(next)
            setStep(1)
        }
        reader.readAsText(file)
    }

    const openCanvas = () => {
        if (!report?.ok || !report.canvas) return
        onOpen({ canvas: report.canvas, name: report.name, route: report.route })
        reset()
    }

    const severity = report?.level === 'compatible' ? 'success' : report?.level === 'attention' ? 'warning' : 'error'

    return (
        <Dialog fullWidth maxWidth='sm' open={open} onClose={close} aria-labelledby='flowise-migration-title'>
            <DialogTitle id='flowise-migration-title' sx={{ fontSize: '1.05rem' }}>
                Flowise migration wizard
            </DialogTitle>
            <DialogContent>
                <Stepper activeStep={step} alternativeLabel sx={{ mb: 2 }}>
                    {STEPS.map((label) => (
                        <Step key={label}>
                            <StepLabel>{label}</StepLabel>
                        </Step>
                    ))}
                </Stepper>
                {step === 0 && (
                    <Stack sx={{ gap: 1.5 }}>
                        {catalogPending && (
                            <Alert severity='info'>The node catalog is loading. File selection will be available shortly.</Alert>
                        )}
                        <Typography variant='body2'>
                            Choose a Flowise chatflow JSON file. The scan lists what will import, which credentials to reconnect, and which
                            nodes Cuttlely will not place. API keys are not copied.
                        </Typography>
                        <Button
                            variant='outlined'
                            component='label'
                            disabled={catalogPending}
                            sx={{ textTransform: 'none', alignSelf: 'flex-start' }}
                        >
                            Choose Flowise JSON
                            <input type='file' hidden disabled={catalogPending} accept='.json,application/json' onChange={onFile} />
                        </Button>
                        {fileName && (
                            <Typography variant='caption' color='text.secondary'>
                                {fileName}
                            </Typography>
                        )}
                        {parseError && <Alert severity='warning'>{parseError}</Alert>}
                    </Stack>
                )}
                {step === 1 && report && (
                    <Stack sx={{ gap: 1 }}>
                        <Alert severity={severity}>{report.title}</Alert>
                        <Typography variant='body2'>
                            {report.counts.nodes} nodes, {report.counts.edges} edges, {report.counts.clean} import with nothing to change.
                        </Typography>
                        {report.fixes.length > 0 && (
                            <Box component='ul' sx={{ m: 0, pl: 2.5 }}>
                                {report.fixes.map((fix, index) => (
                                    <Typography component='li' variant='body2' key={`${index}-${fix}`} sx={{ mt: 0.5 }}>
                                        {fix}
                                    </Typography>
                                ))}
                            </Box>
                        )}
                        {report.attention.length > 0 && (
                            <Box component='ul' sx={{ m: 0, pl: 2.5 }}>
                                {report.attention.map((line, index) => (
                                    <Typography component='li' variant='body2' key={`${index}-${line}`} sx={{ mt: 0.5 }}>
                                        {line}
                                    </Typography>
                                ))}
                            </Box>
                        )}
                    </Stack>
                )}
                {step === 2 && report && (
                    <Stack sx={{ gap: 1 }}>
                        <Typography variant='body2'>
                            Select a credential saved in this app for each slot. Nothing from the file was copied.
                        </Typography>
                        <ListBlock
                            items={report.credentials}
                            empty={emptyCopy.credentials}
                            renderItem={(item) => `${item.label} — ${item.slot}`}
                        />
                    </Stack>
                )}
                {step === 3 && report && (
                    <Stack sx={{ gap: 1.5 }}>
                        <Typography variant='subtitle2'>Deprecated</Typography>
                        <ListBlock
                            items={report.deprecated}
                            empty={emptyCopy.deprecated}
                            renderItem={(item) => `${item.label} — ${item.message}`}
                        />
                        <Typography variant='subtitle2'>Unsupported</Typography>
                        <ListBlock
                            items={report.unsupported}
                            empty={emptyCopy.unsupported}
                            renderItem={(item) => `${item.label} — ${item.message}`}
                        />
                    </Stack>
                )}
                {step === 4 && report && (
                    <Stack sx={{ gap: 1 }}>
                        <Alert severity={severity}>{report.level === 'refused' ? report.reason : report.title}</Alert>
                        {report.ok && report.level === 'attention' && (
                            <Typography variant='body2'>
                                The canvas will open. Finish the credential slots
                                {report.deprecated.length ? ' and the deprecated nodes' : ''} on the graph.
                            </Typography>
                        )}
                        {report.ok && report.level === 'compatible' && (
                            <Typography variant='body2'>
                                This graph uses nodes Cuttlely can draw, with no credential slots left on the file.
                            </Typography>
                        )}
                        {report.attention.length > 0 && (
                            <Box component='ul' sx={{ m: 0, pl: 2.5 }}>
                                {report.attention.map((line, index) => (
                                    <Typography component='li' variant='body2' key={`${index}-${line}`} sx={{ mt: 0.5 }}>
                                        {line}
                                    </Typography>
                                ))}
                            </Box>
                        )}
                    </Stack>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={close} sx={{ textTransform: 'none' }}>
                    Cancel
                </Button>
                {step > 0 && (
                    <Button onClick={() => setStep((current) => current - 1)} sx={{ textTransform: 'none' }}>
                        Back
                    </Button>
                )}
                {step > 0 && step < 4 && (
                    <Button variant='contained' onClick={() => setStep((current) => current + 1)} sx={{ textTransform: 'none' }}>
                        Next
                    </Button>
                )}
                {step === 4 && (
                    <Button variant='contained' disabled={!report?.ok} onClick={openCanvas} sx={{ textTransform: 'none' }}>
                        Open migrated canvas
                    </Button>
                )}
            </DialogActions>
        </Dialog>
    )
}

FlowiseMigrationWizard.propTypes = {
    open: PropTypes.bool,
    onClose: PropTypes.func,
    onOpen: PropTypes.func,
    specs: PropTypes.array,
    updateNodeData: PropTypes.func,
    showHide: PropTypes.shape({ params: PropTypes.func, anchors: PropTypes.func }),
    catalogPending: PropTypes.bool
}

export default FlowiseMigrationWizard
