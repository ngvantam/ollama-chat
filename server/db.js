import sql from 'mssql'

const poolPromises = new Map()

export function validateDatabaseName(value) {
  const database = String(value || '').trim()
  if (!database || database.length > 128 || !/^[A-Za-z0-9._-]+$/.test(database)) {
    throw new Error('Tên database chỉ được chứa chữ, số, dấu chấm, gạch dưới và gạch ngang')
  }
  return database
}

function connectionStringFor(database) {
  const connectionString = process.env.DB_CONNECTION_STRING

  if (!connectionString) {
    throw new Error('DB_CONNECTION_STRING is not configured')
  }

  if (!database) return connectionString
  const selectedDatabase = validateDatabaseName(database)
  const databaseSetting = /(^|;)\s*(Database|Initial Catalog)\s*=\s*[^;]*/i
  if (databaseSetting.test(connectionString)) {
    return connectionString.replace(databaseSetting, `$1Database=${selectedDatabase}`)
  }
  return `${connectionString.replace(/;?\s*$/, '')};Database=${selectedDatabase}`
}

export function getPool(database) {
  const key = database ? validateDatabaseName(database).toLowerCase() : '__default__'
  if (!poolPromises.has(key)) {
    const poolPromise = new sql.ConnectionPool(connectionStringFor(database))
      .connect()
      .catch(error => {
        poolPromises.delete(key)
        throw error
      })
    poolPromises.set(key, poolPromise)
  }
  return poolPromises.get(key)
}

export async function closePool(database) {
  if (database) {
    const key = validateDatabaseName(database).toLowerCase()
    const poolPromise = poolPromises.get(key)
    if (!poolPromise) return
    poolPromises.delete(key)
    await (await poolPromise).close()
    return
  }
  const activePools = [...poolPromises.values()]
  poolPromises.clear()
  await Promise.all(activePools.map(async poolPromise => (await poolPromise).close()))
}
