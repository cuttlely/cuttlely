export const CONNECTION_CHIP_DELAY = 250

export const connectionChipTransition = (count, visible) => {
    if (count <= 0) return { visible: false, delay: null }
    if (visible) return { visible: true, delay: null }
    return { visible: false, delay: CONNECTION_CHIP_DELAY }
}
