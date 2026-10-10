import { createContext } from 'react'

// Which card's settings are open in the canvas side panel, and whether cards use the compact new look. A canvas that
// provides nothing (the version history viewer) keeps classic cards.
export const CanvasPanelContext = createContext({ panelNodeId: null, compact: false })
