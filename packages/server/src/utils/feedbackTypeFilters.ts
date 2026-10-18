import { ChatMessageRatingType } from '../Interface'

/**
 * The ratings a `feedbackType` query value asks for, or undefined for no filter. A string matches by substring, so
 * `THUMBS_UP` and `["THUMBS_UP"]` both work; an array matches whole entries. Any other shape (a nested object from
 * `feedbackType[a]=b`) is no filter, never the raw value.
 */
export function feedbackTypeFilters(value: unknown): ChatMessageRatingType[] | undefined {
    const asks = (rating: ChatMessageRatingType) =>
        typeof value === 'string' ? value.includes(rating) : Array.isArray(value) && value.some((entry) => entry === rating)
    const filters = [ChatMessageRatingType.THUMBS_UP, ChatMessageRatingType.THUMBS_DOWN].filter(asks)
    return filters.length ? filters : undefined
}
