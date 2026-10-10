import moment from 'moment'

// One list format: Oct 5, 2026, 1:40 PM. Callers that only have a date still use this.
export const formatListDateTime = (value) => {
    if (!value) return ''
    const date = moment(value)
    if (!date.isValid()) return ''
    return date.format('MMM D, YYYY, h:mm A')
}
