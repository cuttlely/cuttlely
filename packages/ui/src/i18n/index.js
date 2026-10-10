import en from './en'

// ==============================|| UI STRINGS ||============================== //
// t(key) returns the string for a key. English is the only catalog today; a missing key in
// another locale falls back to English, and an unknown key returns the key itself.

export const DEFAULT_LOCALE = 'en'

const catalogs = { en }

export const t = (key, locale = DEFAULT_LOCALE) => catalogs[locale]?.[key] ?? catalogs[DEFAULT_LOCALE][key] ?? key

export default t
