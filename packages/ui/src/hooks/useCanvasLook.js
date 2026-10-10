import { useEffect, useState } from 'react'
import { useConfig } from '@/store/context/ConfigContext'
import { CANVAS_LOOK_EVENT, CANVAS_LOOK_KEY, readCanvasLook, serverDefaultLook, writeCanvasLook } from '@/utils/canvasLook'

// The canvas look for this browser, kept in step across canvases and tabs. Without a choice of its own it follows the
// server default.
export default function useCanvasLook() {
    const fallback = serverDefaultLook(useConfig()?.config)
    const [look, setLook] = useState(() => readCanvasLook(undefined, fallback))

    useEffect(() => {
        setLook(readCanvasLook(undefined, fallback))
    }, [fallback])

    useEffect(() => {
        const sync = () => setLook(readCanvasLook(undefined, fallback))
        const onStorage = (event) => {
            if (event.key === CANVAS_LOOK_KEY) sync()
        }
        window.addEventListener(CANVAS_LOOK_EVENT, sync)
        window.addEventListener('storage', onStorage)
        return () => {
            window.removeEventListener(CANVAS_LOOK_EVENT, sync)
            window.removeEventListener('storage', onStorage)
        }
    }, [fallback])

    return [look, (next) => setLook(writeCanvasLook(next))]
}
