import { useEffect, useMemo, useState } from 'react'
import PropTypes from 'prop-types'

import { Box, Button, Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography } from '@mui/material'

import usageApi from '@/api/usage'
import { apiErrorMessage, formatRate, priceInputError, priceRows } from './query'

const draftFrom = (row) => ({
    input: row.override ? String(row.override.input) : '',
    output: row.override ? String(row.override.output) : ''
})

const PriceEditor = ({ unpricedModels, onChanged, client = usageApi }) => {
    const [catalog, setCatalog] = useState([])
    const [drafts, setDrafts] = useState({})
    const [find, setFind] = useState('')
    const [error, setError] = useState('')
    const [busy, setBusy] = useState('')

    const rows = useMemo(() => priceRows(catalog, unpricedModels), [catalog, unpricedModels])

    const remember = (next) => {
        setCatalog(next)
        setDrafts((prev) => {
            const draftsNext = { ...prev }
            for (const row of next) {
                if (!draftsNext[row.model]) draftsNext[row.model] = draftFrom(row)
            }
            return draftsNext
        })
    }

    const load = async () => {
        const result = await client.getModelPrices()
        const next = result.data?.models || []
        setCatalog(next)
        setDrafts((prev) => {
            const draftsNext = {}
            for (const row of next) draftsNext[row.model] = prev[row.model] || draftFrom(row)
            return draftsNext
        })
    }

    useEffect(() => {
        let cancelled = false
        client
            .getModelPrices()
            .then((result) => {
                if (cancelled) return
                remember(result.data?.models || [])
                setError('')
            })
            .catch((err) => {
                if (!cancelled) setError(apiErrorMessage(err, 'Could not load model prices.'))
            })
        return () => {
            cancelled = true
        }
        // Load once. A later usage refresh only adds unpriced names that are not in this list.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const shown = rows.filter((row) => String(row.model).toLowerCase().includes(find.trim().toLowerCase()))

    const setDraft = (model, field, value) => {
        setDrafts((prev) => ({
            ...prev,
            [model]: { input: prev[model]?.input || '', output: prev[model]?.output || '', [field]: value }
        }))
    }

    const save = async (model) => {
        const draft = drafts[model] || { input: '', output: '' }
        const problem = priceInputError('Input', draft.input) || priceInputError('Output', draft.output)
        if (problem) {
            setError(problem)
            return
        }
        setBusy(model)
        setError('')
        try {
            await client.setModelPrice({ model, input: Number(draft.input), output: Number(draft.output) })
            await load()
            if (onChanged) await onChanged()
        } catch (err) {
            setError(apiErrorMessage(err, 'Could not save that price.'))
        } finally {
            setBusy('')
        }
    }

    const clear = async (model) => {
        setBusy(model)
        setError('')
        try {
            await client.clearModelPrice(model)
            setDrafts((prev) => ({ ...prev, [model]: { input: '', output: '' } }))
            await load()
            if (onChanged) await onChanged()
        } catch (err) {
            setError(apiErrorMessage(err, 'Could not clear that price.'))
        } finally {
            setBusy('')
        }
    }

    return (
        <Box id='model-prices' component='section' aria-label='Model prices' sx={{ mt: 1 }}>
            <Typography variant='h4' sx={{ mb: 0.5 }}>
                Model prices
            </Typography>
            <Typography variant='body2' color='text.secondary' sx={{ mb: 1.5 }}>
                US dollars per million tokens. An override replaces the default. Clear uses the default again. A model with no default and
                no override stays no price.
            </Typography>
            <TextField
                size='small'
                value={find}
                onChange={(event) => setFind(event.target.value)}
                placeholder='Find a model'
                inputProps={{ 'aria-label': 'Find a model' }}
                sx={{ mb: 1.5, minWidth: 240 }}
            />
            {error && (
                <Typography role='alert' color='error' sx={{ mb: 1 }}>
                    {error}
                </Typography>
            )}
            <Box sx={{ maxHeight: 420, overflow: 'auto' }}>
                <Table size='small' aria-label='Model price overrides'>
                    <TableHead>
                        <TableRow>
                            <TableCell>Model</TableCell>
                            <TableCell>Default input</TableCell>
                            <TableCell>Default output</TableCell>
                            <TableCell>Override input</TableCell>
                            <TableCell>Override output</TableCell>
                            <TableCell />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {shown.map((row) => {
                            const draft = drafts[row.model] || draftFrom(row)
                            return (
                                <TableRow key={row.model}>
                                    <TableCell>{row.model}</TableCell>
                                    <TableCell>{formatRate(row.default?.input)}</TableCell>
                                    <TableCell>{formatRate(row.default?.output)}</TableCell>
                                    <TableCell>
                                        <Box
                                            component='input'
                                            aria-label={`Input price for ${row.model}`}
                                            value={draft.input}
                                            onChange={(event) => setDraft(row.model, 'input', event.target.value)}
                                            sx={{ width: 110, font: 'inherit', px: 1, py: 0.5 }}
                                        />
                                    </TableCell>
                                    <TableCell>
                                        <Box
                                            component='input'
                                            aria-label={`Output price for ${row.model}`}
                                            value={draft.output}
                                            onChange={(event) => setDraft(row.model, 'output', event.target.value)}
                                            sx={{ width: 110, font: 'inherit', px: 1, py: 0.5 }}
                                        />
                                    </TableCell>
                                    <TableCell>
                                        <Stack direction='row' spacing={1}>
                                            <Button
                                                size='small'
                                                variant='contained'
                                                aria-label={`Set price for ${row.model}`}
                                                disabled={busy === row.model}
                                                onClick={() => save(row.model)}
                                            >
                                                Set
                                            </Button>
                                            <Button
                                                size='small'
                                                variant='outlined'
                                                aria-label={`Clear price for ${row.model}`}
                                                disabled={busy === row.model || !row.override}
                                                onClick={() => clear(row.model)}
                                            >
                                                Clear
                                            </Button>
                                        </Stack>
                                    </TableCell>
                                </TableRow>
                            )
                        })}
                        {shown.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={6}>No model matches that name.</TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </Box>
        </Box>
    )
}

PriceEditor.propTypes = {
    unpricedModels: PropTypes.array,
    onChanged: PropTypes.func,
    client: PropTypes.object
}

export default PriceEditor
