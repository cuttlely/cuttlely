import { filterChoices, missingNames, savedValue, selectedNames, selectionSummary, splitOptions, toggleName } from './checkboxList'

const choices = [
    { name: 'public.monthly_sales', label: 'public.monthly_sales', description: 'materialized view · 6 columns · Shop sales per month' },
    { name: 'public.account_balances', label: 'public.account_balances', description: 'view · 6 columns · What each account owes' },
    { name: 'public.stores', label: 'public.stores', description: 'table · 4 columns · Bakery shops' }
]

describe('checkbox list', () => {
    it('reads the saved JSON array and treats anything else as no selection', () => {
        expect(selectedNames('["public.stores"]')).toEqual(['public.stores'])
        expect(selectedNames('')).toEqual([])
        expect(selectedNames('choose an option')).toEqual([])
        expect(selectedNames('not json')).toEqual([])
        expect(selectedNames(['public.stores', 3])).toEqual(['public.stores'])
    })

    it('saves an empty selection as an empty string', () => {
        expect(savedValue([])).toBe('')
        expect(savedValue(['public.stores'])).toBe('["public.stores"]')
    })

    it('keeps load method messages apart from choices', () => {
        const { choices: picked, messages } = splitOptions([...choices, { name: 'error', label: 'Could not list tables and views' }])
        expect(picked).toHaveLength(3)
        expect(messages).toEqual([{ name: 'error', label: 'Could not list tables and views' }])
    })

    it('toggles in list order and keeps a saved name the list no longer has', () => {
        expect(toggleName([], choices, 'public.stores')).toEqual(['public.stores'])
        expect(toggleName(['public.stores'], choices, 'public.monthly_sales')).toEqual(['public.monthly_sales', 'public.stores'])
        expect(toggleName(['public.stores', 'public.gone'], choices, 'public.stores')).toEqual(['public.gone'])
        expect(missingNames(['public.gone', 'public.stores'], choices)).toEqual(['public.gone'])
    })

    it('filters on the name, the kind and the comment', () => {
        expect(filterChoices(choices, 'view').map((option) => option.name)).toEqual(['public.monthly_sales', 'public.account_balances'])
        expect(filterChoices(choices, 'SHOPS').map((option) => option.name)).toEqual(['public.stores'])
        expect(filterChoices(choices, ' ')).toBe(choices)
    })

    it('says what an empty selection means', () => {
        expect(selectionSummary([], choices)).toMatch(/every table/)
        expect(selectionSummary(['public.stores'], choices)).toBe('1 of 3 ticked. Queries that read anything else are refused.')
    })
})
