import { ChatMessageRatingType } from '../Interface'
import { feedbackTypeFilters } from './feedbackTypeFilters'

const UP = ChatMessageRatingType.THUMBS_UP
const DOWN = ChatMessageRatingType.THUMBS_DOWN

describe('feedbackTypeFilters', () => {
    it('reads one rating, both, or a JSON list from the query', () => {
        expect(feedbackTypeFilters(UP)).toEqual([UP])
        expect(feedbackTypeFilters([DOWN])).toEqual([DOWN])
        expect(feedbackTypeFilters([DOWN, UP])).toEqual([UP, DOWN])
        expect(feedbackTypeFilters(JSON.stringify([UP, DOWN]))).toEqual([UP, DOWN])
    })

    it('is no filter when nothing or nothing known is asked for', () => {
        expect(feedbackTypeFilters(undefined)).toBeUndefined()
        expect(feedbackTypeFilters('')).toBeUndefined()
        expect(feedbackTypeFilters(['SOMETHING_ELSE'])).toBeUndefined()
    })

    it('never passes a tampered query shape through', () => {
        expect(feedbackTypeFilters({ [UP]: 'x' })).toBeUndefined()
        expect(feedbackTypeFilters([{ includes: () => true }])).toBeUndefined()
        expect(feedbackTypeFilters(42)).toBeUndefined()
    })
})
