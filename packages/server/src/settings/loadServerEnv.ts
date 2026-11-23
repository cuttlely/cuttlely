// The logger and the settings bootstrap share this import so package-level host values are loaded once.
import dotenv from 'dotenv'
import path from 'path'

dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), override: true })
