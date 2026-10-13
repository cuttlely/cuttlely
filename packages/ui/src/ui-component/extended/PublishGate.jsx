import { useEffect, useState } from 'react'
import PropTypes from 'prop-types'
import { useDispatch } from 'react-redux'

import { Alert, Box, Stack, TextField, Typography } from '@mui/material'

import datasetsApi from '@/api/dataset'
import evaluatorsApi from '@/api/evaluators'
import flowDraftsApi from '@/api/flowDrafts'
import { useAuth } from '@/hooks/useAuth'
import { SwitchInput } from '@/ui-component/switch/Switch'
import { apiErrorMessage } from '@/utils/flowDrafts'
import { enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'

const asList = (payload) => (Array.isArray(payload) ? payload : payload?.data || [])

const PublishGate = ({ dialogProps }) => {
    const dispatch = useDispatch()
    const { hasPermission } = useAuth()
    const chatflow = dialogProps?.chatflow
    const draftStatus = dialogProps?.draftStatus
    const gate = draftStatus?.publishGate
    const locked = Boolean(draftStatus?.publishInstantly)
    const canChoose = hasPermission('datasets:view') && hasPermission('evaluators:view')
    const [on, setOn] = useState(Boolean(gate?.enabled))
    const [datasetId, setDatasetId] = useState(gate?.datasetId || '')
    const [evaluatorIds, setEvaluatorIds] = useState(gate?.evaluatorIds || [])
    const [threshold, setThreshold] = useState(gate?.threshold ?? 100)
    const [datasets, setDatasets] = useState([])
    const [evaluators, setEvaluators] = useState([])
    const [error, setError] = useState('')

    const evaluatorKey = (gate?.evaluatorIds || []).join(',')
    useEffect(() => {
        setOn(Boolean(gate?.enabled))
        setDatasetId(gate?.datasetId || '')
        setEvaluatorIds(gate?.evaluatorIds || [])
        setThreshold(gate?.threshold ?? 100)
    }, [gate?.enabled, gate?.datasetId, gate?.threshold, gate?.evaluatorIds, evaluatorKey])

    useEffect(() => {
        if (!canChoose) return undefined
        let cancelled = false
        datasetsApi
            .getAllDatasets()
            .then((res) => {
                if (!cancelled) setDatasets(asList(res.data))
            })
            .catch(() => {
                if (!cancelled) setDatasets([])
            })
        evaluatorsApi
            .getAllEvaluators()
            .then((res) => {
                if (!cancelled) setEvaluators(asList(res.data))
            })
            .catch(() => {
                if (!cancelled) setEvaluators([])
            })
        return () => {
            cancelled = true
        }
    }, [canChoose])

    const save = async (next) => {
        if (!chatflow?.id) return
        setError('')
        const whole = Number(next.threshold)
        if (next.enabled && (!next.datasetId || !next.evaluatorIds.length)) {
            setOn(Boolean(gate?.enabled))
            setError('Choose a dataset and at least one evaluator.')
            return
        }
        if (next.enabled && (!Number.isInteger(whole) || whole < 0 || whole > 100)) {
            setOn(Boolean(gate?.enabled))
            setError('The pass mark is a whole number from 0 to 100.')
            return
        }
        try {
            const res = await flowDraftsApi.updateSettings(chatflow.id, {
                publishGate: next.enabled
                    ? { enabled: true, datasetId: next.datasetId, evaluatorIds: next.evaluatorIds, threshold: whole }
                    : { enabled: false }
            })
            if (res.data) dialogProps.onDraftStatus?.(res.data)
            dispatch(
                enqueueSnackbarAction({
                    message: next.enabled ? 'Publish waits for a passing test set.' : 'Publish no longer waits for a test set.',
                    options: { key: new Date().getTime() + Math.random(), variant: 'success' }
                })
            )
        } catch (err) {
            setOn(Boolean(gate?.enabled))
            setError(apiErrorMessage(err, 'That setting could not be saved.'))
        }
    }

    const toggleEvaluator = (id) => {
        const nextIds = evaluatorIds.includes(id) ? evaluatorIds.filter((item) => item !== id) : [...evaluatorIds, id]
        setEvaluatorIds(nextIds)
        if (on) save({ enabled: true, datasetId, evaluatorIds: nextIds, threshold })
    }

    return (
        <Box data-testid='publish-gate-settings'>
            {locked && (
                <Alert severity='info' sx={{ mb: 1 }}>
                    Turn off Publish instantly before requiring a passing test set.
                </Alert>
            )}
            {!canChoose && (
                <Alert severity='info' sx={{ mb: 1 }}>
                    You need permission to view datasets and evaluators before requiring a passing test set.
                </Alert>
            )}
            <SwitchInput
                label='Require a passing test set before Publish'
                value={on}
                disabled={locked || !canChoose}
                onChange={(next) => {
                    setOn(next)
                    save({ enabled: next, datasetId, evaluatorIds, threshold })
                }}
            />
            <Typography variant='body2' color='text.secondary' sx={{ mt: 1 }}>
                Publish is refused until this draft passes the dataset at the mark you set. Errored rows count as not passed.
            </Typography>
            <Stack spacing={1} sx={{ mt: 1.5 }}>
                <TextField
                    select
                    size='small'
                    label='Dataset'
                    value={datasetId}
                    disabled={locked || !canChoose}
                    onChange={(event) => {
                        const nextId = event.target.value
                        setDatasetId(nextId)
                        if (on) save({ enabled: true, datasetId: nextId, evaluatorIds, threshold })
                    }}
                    SelectProps={{ native: true }}
                    inputProps={{ 'aria-label': 'Dataset', 'data-testid': 'publish-gate-dataset' }}
                >
                    <option value=''>Choose a dataset</option>
                    {datasets.map((item) => (
                        <option key={item.id} value={item.id}>
                            {item.name}
                        </option>
                    ))}
                </TextField>
                <TextField
                    size='small'
                    type='number'
                    label='Pass at'
                    value={threshold}
                    disabled={locked || !canChoose}
                    onChange={(event) => setThreshold(event.target.value)}
                    onBlur={() => {
                        if (on) save({ enabled: true, datasetId, evaluatorIds, threshold })
                    }}
                    inputProps={{ 'aria-label': 'Pass at', min: 0, max: 100, step: 1, 'data-testid': 'publish-gate-threshold' }}
                    helperText='A whole number from 0 to 100. 100 means every score passed.'
                />
                <Typography variant='body2' sx={{ fontWeight: 600 }}>
                    Evaluators
                </Typography>
                {evaluators.length === 0 ? (
                    <Typography variant='body2' color='text.secondary'>
                        No evaluators in this workspace.
                    </Typography>
                ) : (
                    evaluators.map((evaluator) => (
                        <label key={evaluator.id} data-testid='publish-gate-evaluator'>
                            <input
                                type='checkbox'
                                checked={evaluatorIds.includes(evaluator.id)}
                                disabled={locked || !canChoose}
                                onChange={() => toggleEvaluator(evaluator.id)}
                            />{' '}
                            {evaluator.name}
                        </label>
                    ))
                )}
            </Stack>
            {error && (
                <Alert severity='error' sx={{ mt: 1 }}>
                    {error}
                </Alert>
            )}
        </Box>
    )
}

PublishGate.propTypes = {
    dialogProps: PropTypes.object
}

export default PublishGate
