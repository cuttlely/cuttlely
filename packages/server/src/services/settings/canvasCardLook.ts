// The card look people see on the canvas until they choose one: 'new' (compact cards, settings in a side panel) unless
// the server sets CANVAS_CARD_LOOK=classic. Each person can still turn Classic cards on or off for themselves.
export const canvasCardLook = (value: string | undefined = process.env.CANVAS_CARD_LOOK): 'classic' | 'new' =>
    String(value || '')
        .trim()
        .toLowerCase() === 'classic'
        ? 'classic'
        : 'new'
