import PropTypes from 'prop-types'
import { useState } from 'react'
import pinnedQueriesApi from '@/api/pinnedQueries'
import { PinnedQueriesView } from './PinnedQueriesView'
import {
    applySuggestions,
    blankEditor,
    describePin,
    editorFromPin,
    entryFromEditor,
    mergeTestedPin,
    messageFrom,
    pinWarning,
    readPins,
    removeTrailingSemicolon,
    addLimit100,
    sampleValuesFrom,
    specialistPinTotal,
    withParam,
    withPurpose,
    withSql,
    cleanSlug
} from './model'

// The dialog edits a draft in memory. Test & save is the only write of a tested entry.
// Remove updates the list on the node and marks the canvas dirty. The flow is not published here.
export default function PinnedQueriesBlock({
    enabled = false,
    chatflowId,
    nodeId,
    canvas,
    pins,
    nodes,
    edges,
    disabled = false,
    onChange
}) {
    const list = readPins(pins)
    const [editor, setEditor] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const [result, setResult] = useState(null)
    const warning = pinWarning(specialistPinTotal(nodes, edges, nodeId))

    if (!enabled) return null

    const changeField = (name, value) => {
        setError('')
        setEditor((current) => {
            if (!current) return current
            if (name === 'purpose')
                return withPurpose(
                    current,
                    value,
                    list.filter((pin) => pin.id !== current.id)
                )
            if (name === 'sql') return withSql(current, value)
            if (name === 'slug') return { ...current, slug: cleanSlug(value), slugTouched: true }
            if (name === 'description') return { ...current, description: value, descriptionTouched: true }
            if (name === 'rowCap') return { ...current, rowCap: value }
            return current
        })
    }

    const testAndSave = async () => {
        if (!editor || disabled) return
        if (!chatflowId) {
            setError('Save the flow first so the test can use this canvas.')
            return
        }
        if (!String(editor.purpose || '').trim()) {
            setError('Write a one-line purpose.')
            return
        }
        if (!editor.slug) {
            setError('The tool name must be pq_ plus a short slug.')
            return
        }
        setBusy(true)
        setError('')
        let current = editor
        try {
            if (current.params.some((param) => !param.type)) {
                try {
                    const suggested = await pinnedQueriesApi.suggestPinnedTypes(chatflowId, {
                        nodeId,
                        sql: current.sql,
                        ...(canvas ? { canvas } : {})
                    })
                    current = { ...current, params: applySuggestions(current.params, suggested?.data?.params) }
                    setEditor(current)
                } catch {
                    // A missed suggestion leaves the dropdown blank. It does not become text.
                }
            }
            if (current.params.some((param) => !param.type)) {
                setError('Choose a type for every parameter. Postgres could not tell for the ones still blank.')
                setBusy(false)
                return
            }
            const description = current.descriptionTouched
                ? current.description
                : describePin(current.purpose, current.params, current.testedColumns)
            const payload = entryFromEditor({ ...current, description })
            const response = await pinnedQueriesApi.testPinnedQuery(chatflowId, {
                nodeId,
                entry: payload,
                sampleValues: sampleValuesFrom(current),
                ...(canvas ? { canvas } : {})
            })
            const tested = response?.data?.entry
            if (!tested) throw new Error('The test did not return a saved query.')
            if (!current.descriptionTouched) {
                tested.description = describePin(tested.purpose, tested.params, response.data.columns)
            }
            onChange(mergeTestedPin(list, tested))
            setEditor({
                ...editorFromPin(tested),
                samples: current.samples,
                descriptionTouched: current.descriptionTouched,
                slugTouched: true
            })
            setResult(response.data)
        } catch (caught) {
            setResult(null)
            setError(messageFrom(caught))
        } finally {
            setBusy(false)
        }
    }

    return (
        <PinnedQueriesView
            enabled
            pins={list}
            editor={editor}
            warning={warning}
            busy={busy}
            disabled={disabled}
            error={error}
            result={result}
            onAdd={() => {
                setError('')
                setResult(null)
                setEditor(blankEditor(list))
            }}
            onEdit={(pin) => {
                setError('')
                setResult(null)
                setEditor(editorFromPin(pin))
            }}
            onRemove={(id) => {
                onChange(list.filter((pin) => pin.id !== id))
                if (editor?.id === id) setEditor(null)
            }}
            onClose={() => {
                setEditor(null)
                setError('')
                setResult(null)
            }}
            onField={changeField}
            onParam={(name, patch) => setEditor((current) => (current ? withParam(current, name, patch) : current))}
            onSample={(name, value) =>
                setEditor((current) => (current ? { ...current, samples: { ...current.samples, [name]: value } } : current))
            }
            onRemoveSemicolon={() => setEditor((current) => (current ? withSql(current, removeTrailingSemicolon(current.sql)) : current))}
            onAddLimit={() => setEditor((current) => (current ? withSql(current, addLimit100(current.sql)) : current))}
            onTestSave={testAndSave}
        />
    )
}

PinnedQueriesBlock.propTypes = {
    enabled: PropTypes.bool,
    chatflowId: PropTypes.string,
    nodeId: PropTypes.string,
    canvas: PropTypes.object,
    pins: PropTypes.oneOfType([PropTypes.array, PropTypes.string]),
    nodes: PropTypes.array,
    edges: PropTypes.array,
    disabled: PropTypes.bool,
    onChange: PropTypes.func
}
