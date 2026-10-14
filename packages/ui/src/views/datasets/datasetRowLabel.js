export function datasetRowNeedsExpectedAnswer(row) {
    return row?.needsExpectedAnswer === true || row?.needsExpectedAnswer === 1
}

export function datasetRowExpectedLabel(row) {
    if (datasetRowNeedsExpectedAnswer(row)) return 'needs expected answer'
    return row?.output ?? ''
}
