import { useCallback, useEffect, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { useNodesInitialized, useReactFlow } from 'reactflow'
import { Button } from '@mui/material'
import { IconLayoutBoardSplit, IconX } from '@tabler/icons-react'

import { canUndoTidy, tidyStep, undoTidy } from '@/utils/tidyHarnessLayout'

export const TIDY_MESSAGE = 'Tidied the canvas. Save to keep the new layout.'

// Ctrl/Cmd+Z in a field or a dialog is that field's own undo.
export function isTidyUndoKey(event) {
    if (!event || event.repeat || event.shiftKey || event.altKey) return false
    if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== 'z') return false
    const target = event.target
    if (target && typeof target.closest === 'function') {
        if (target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]')) return false
    }
    return true
}

// Rearranges the harness canvas. It changes card positions only and never saves: the canvas is marked changed and
// the person's own Save keeps the layout. One Undo (the snackbar button or Ctrl/Cmd+Z) puts every card back while
// no card has been moved, added or removed and the canvas has not been saved.
const TidyLayoutButton = ({ nodes, edges, setNodes, isDirty, onDirty, enqueueSnackbar, closeSnackbar }) => {
    const { fitView } = useReactFlow()
    const measured = useNodesInitialized()
    const [undo, setUndo] = useState(null)
    const snackbarKey = useRef(null)
    const nodesRef = useRef(nodes)
    nodesRef.current = nodes

    const dropUndo = useCallback(() => {
        setUndo(null)
        if (snackbarKey.current != null) closeSnackbar(snackbarKey.current)
        snackbarKey.current = null
    }, [closeSnackbar])

    const runUndo = useCallback(() => {
        if (!canUndoTidy(undo, nodesRef.current)) return false
        setNodes(undoTidy(undo, nodesRef.current))
        onDirty()
        dropUndo()
        return true
    }, [undo, setNodes, onDirty, dropUndo])

    const runUndoRef = useRef(runUndo)
    runUndoRef.current = runUndo

    const tidy = () => {
        const step = tidyStep(nodesRef.current, edges)
        if (!step.undo) {
            enqueueSnackbar({
                message: 'The canvas is already tidy.',
                options: { key: new Date().getTime() + Math.random(), variant: 'info' }
            })
            return
        }
        if (snackbarKey.current != null) closeSnackbar(snackbarKey.current)
        setNodes(step.nodes)
        setUndo(step.undo)
        onDirty()
        const key = new Date().getTime() + Math.random()
        snackbarKey.current = key
        enqueueSnackbar({
            message: TIDY_MESSAGE,
            options: {
                key,
                variant: 'success',
                action: (actionKey) => (
                    <>
                        <Button style={{ color: 'white' }} onClick={() => runUndoRef.current()}>
                            Undo
                        </Button>
                        <Button style={{ color: 'white' }} aria-label='Close' onClick={() => closeSnackbar(actionKey)}>
                            <IconX />
                        </Button>
                    </>
                )
            }
        })
        setTimeout(() => fitView({ padding: 0.2, maxZoom: 1, duration: 200 }), 0)
    }

    // Moving, adding or removing a card, or a save, ends the undo.
    useEffect(() => {
        if (undo && !canUndoTidy(undo, nodes)) dropUndo()
    }, [undo, nodes, dropUndo])
    // A save clears the changed flag. The flag Tidy sets can reach here a render later, so only the change from
    // changed to saved counts.
    const wasDirty = useRef(isDirty)
    useEffect(() => {
        if (wasDirty.current && !isDirty && undo) dropUndo()
        wasDirty.current = isDirty
    }, [undo, isDirty, dropUndo])

    useEffect(() => {
        if (!undo) return undefined
        const onKeyDown = (event) => {
            if (!isTidyUndoKey(event)) return
            if (runUndoRef.current()) event.preventDefault()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [undo])

    const ready = measured && nodes.length > 0
    return (
        <button
            type='button'
            className='react-flow__controls-button react-flow__controls-interactive'
            onClick={tidy}
            disabled={!ready}
            title={ready ? 'Tidy layout' : 'Tidy layout (waiting for the cards to load)'}
            aria-label='Tidy layout'
        >
            <IconLayoutBoardSplit />
        </button>
    )
}

TidyLayoutButton.propTypes = {
    nodes: PropTypes.array.isRequired,
    edges: PropTypes.array.isRequired,
    setNodes: PropTypes.func.isRequired,
    isDirty: PropTypes.bool,
    onDirty: PropTypes.func.isRequired,
    enqueueSnackbar: PropTypes.func.isRequired,
    closeSnackbar: PropTypes.func.isRequired
}

export default TidyLayoutButton
