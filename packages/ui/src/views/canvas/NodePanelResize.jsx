import PropTypes from 'prop-types'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSelector } from 'react-redux'
import { Box } from '@mui/material'

import {
    CANVAS_MIN_WIDTH,
    PANEL_DEFAULT_WIDTH,
    PANEL_MIN_WIDTH,
    clampPanelWidth,
    panelMaxFor,
    panelWidthKey,
    readPanelWidth,
    savePanelWidth,
    widthAfterDrag,
    widthAfterKey
} from '@/utils/nodePanelWidth'

const storage = () => (typeof window === 'undefined' ? null : window.localStorage)
const viewportWidth = () => (typeof window === 'undefined' ? undefined : window.innerWidth)

// Panel width remembered per signed-in user in this browser, plus a session-only expanded state.
export function useNodePanelWidth() {
    const userId = useSelector((state) => state?.auth?.user?.id)
    const key = panelWidthKey(userId)
    const [width, setWidth] = useState(() => clampPanelWidth(readPanelWidth(storage(), key), viewportWidth()))
    const [expanded, setExpanded] = useState(false)

    useEffect(() => {
        setWidth(clampPanelWidth(readPanelWidth(storage(), key), viewportWidth()))
    }, [key])

    useEffect(() => {
        if (typeof window === 'undefined') return undefined
        const onResize = () => setWidth((current) => clampPanelWidth(current, viewportWidth()))
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    const commit = useCallback(
        (next) => {
            setWidth(next)
            savePanelWidth(storage(), next, key)
        },
        [key]
    )

    return {
        width,
        expanded,
        setWidth,
        commit,
        toggleExpanded: () => setExpanded((value) => !value),
        // Expanded keeps a thin strip of canvas so the flow stays mounted and a click there still closes the panel.
        widthSx: expanded ? { width: 'calc(100% - 48px)' } : { width, maxWidth: `calc(100% - ${CANVAS_MIN_WIDTH}px)` }
    }
}

export function PanelResizeHandle({ width, onPreview, onCommit, hidden = false }) {
    const drag = useRef(null)
    const last = useRef(width)
    last.current = width
    if (hidden) return null

    const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return
        event.preventDefault()
        drag.current = { startX: event.clientX, startWidth: last.current }
        event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    const onPointerMove = (event) => {
        if (!drag.current) return
        onPreview(widthAfterDrag(drag.current.startWidth, drag.current.startX, event.clientX, viewportWidth()))
    }
    const onPointerUp = (event) => {
        if (!drag.current) return
        const next = widthAfterDrag(drag.current.startWidth, drag.current.startX, event.clientX, viewportWidth())
        drag.current = null
        event.currentTarget.releasePointerCapture?.(event.pointerId)
        onCommit(next)
    }
    const onKeyDown = (event) => {
        const next = widthAfterKey(last.current, event.key, viewportWidth())
        if (next === null) return
        event.preventDefault()
        event.stopPropagation()
        onCommit(next)
    }

    return (
        <Box
            role='separator'
            aria-orientation='vertical'
            aria-label='Resize settings panel'
            aria-valuenow={width}
            aria-valuemin={PANEL_MIN_WIDTH}
            aria-valuemax={panelMaxFor(viewportWidth())}
            tabIndex={0}
            title='Drag to resize. Double-click to reset.'
            data-testid='node-panel-resize'
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onDoubleClick={() => onCommit(clampPanelWidth(PANEL_DEFAULT_WIDTH, viewportWidth()))}
            onKeyDown={onKeyDown}
            sx={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: 8,
                cursor: 'col-resize',
                zIndex: 4,
                touchAction: 'none',
                '&:hover, &:focus-visible': { backgroundColor: 'primary.main', opacity: 0.4, outline: 'none' }
            }}
        />
    )
}

PanelResizeHandle.propTypes = {
    width: PropTypes.number.isRequired,
    onPreview: PropTypes.func.isRequired,
    onCommit: PropTypes.func.isRequired,
    hidden: PropTypes.bool
}
