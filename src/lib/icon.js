import path from 'path'

/**
 * Pasta base para dados persistentes.
 * - Usa DATA_FOLDER se definida
 * - Caso contrário, cai para /data (padrão de container)
 */
const dataFolder = process.env.DATA_FOLDER || '/data'

/**
 * Caminho absoluto do ícone do addon
 */
export const iconPath = path.join(
  dataFolder,
  'icon.png'
)
