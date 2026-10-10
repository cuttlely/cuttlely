// The example name in the Save New dialog. The harness canvas says harness; every other caller keeps the old text.
export const DEFAULT_SAVE_PLACEHOLDER = 'My New Chatflow'

export const saveFlowPlaceholder = ({ isHarnessCanvas } = {}) => (isHarnessCanvas ? 'My New Harness' : DEFAULT_SAVE_PLACEHOLDER)
