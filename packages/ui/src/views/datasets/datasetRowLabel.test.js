import { datasetRowExpectedLabel, datasetRowNeedsExpectedAnswer } from './datasetRowLabel'

test('a thumbs-down row shows that it needs an expected answer', () => {
    expect(datasetRowNeedsExpectedAnswer({ needsExpectedAnswer: true, output: '' })).toBe(true)
    expect(datasetRowNeedsExpectedAnswer({ needsExpectedAnswer: 1, output: '' })).toBe(true)
    expect(datasetRowExpectedLabel({ needsExpectedAnswer: true, output: '' })).toBe('needs expected answer')
    expect(datasetRowExpectedLabel({ needsExpectedAnswer: false, output: 'In the back.' })).toBe('In the back.')
})
