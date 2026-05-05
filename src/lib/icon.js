import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const iconPath = path.join(__dirname, '..', 'static', 'img', 'jackio.png')
