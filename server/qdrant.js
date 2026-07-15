import { QdrantClient } from '@qdrant/js-client-rest'
import { validateDatabaseName } from './db.js'

const embeddingModel = process.env.QDRANT_EMBEDDING_MODEL || 'sentence-transformers/all-MiniLM-L6-v2'
const vectorSize = Number.parseInt(process.env.QDRANT_VECTOR_SIZE || '384', 10)
const collectionSyncTasks = new Map()

function getClient() {
  const url = process.env.QDRANT_URL?.trim()
  const apiKey = process.env.QDRANT_API_KEY?.trim()
  if (!url || !apiKey) throw new Error('QDRANT_URL và QDRANT_API_KEY chưa được cấu hình trong .env')
  return new QdrantClient({ url, apiKey, timeout: 300_000 })
}

export function getGoodsCollection(database) {
  return `goods_${validateDatabaseName(database).toLowerCase().replaceAll('.', '_').replaceAll('-', '_')}`
}

function cleanPayload(row, database) {
  return Object.fromEntries([
    ['database', database],
    ...Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Date ? value.toISOString() : value,
    ]),
  ].filter(([, value]) => value !== null && value !== '' && value !== undefined))
}

function productDocument(payload) {
  return [
    `Nhóm sản phẩm: ${payload.DetailName1 || ''}`,
    `Tên sản phẩm: ${payload.DetailName2 || payload.WebGoodNameVietNam || payload.DetailName1 || ''}`,
    `Mã nhóm: ${payload.Detail1 || ''}`,
    `Mã sản phẩm: ${payload.Detail2 || ''}`,
    `Giá bán: ${payload.SalePrice ?? ''}`,
    `Bảng giá: ${payload.PriceList || ''}`,
    `Tài khoản: ${payload.AccountName || payload.Account || ''}`,
    `Trạng thái: ${payload.Status ?? ''}`,
    `Đơn vị: ${payload.StockUnit || ''}`,
    `Tồn hiện tại: ${payload.Inventory ?? ''}`,
    `Tồn đầu kỳ: ${payload.OpeningStockQuantityNB ?? ''}`,
    `Mô tả: ${payload.ContentVietNam || ''}`,
  ].join('. ')
}

export async function syncGoodsToQdrant(database, rows) {
  const collection = getGoodsCollection(database)
  if (collectionSyncTasks.has(collection)) {
    throw new Error(`Collection ${collection} đang được đồng bộ`)
  }

  const syncTask = (async () => {
    const client = getClient()
    const exists = await client.collectionExists(collection)
    if (exists.exists) await client.deleteCollection(collection)
    await client.createCollection(collection, {
      vectors: { size: vectorSize, distance: 'Cosine' },
    })

    const points = rows.map(row => {
      const payload = cleanPayload(row, database)
      return {
        id: Number(row.Id),
        vector: { text: productDocument(payload), model: embeddingModel },
        payload,
      }
    })
    for (let index = 0; index < points.length; index += 32) {
      await client.upsert(collection, { wait: true, points: points.slice(index, index + 32) })
    }
    return { collection, rows: points.length, embeddingModel }
  })()

  collectionSyncTasks.set(collection, syncTask)
  try {
    return await syncTask
  } finally {
    collectionSyncTasks.delete(collection)
  }
}

export async function searchGoods(database, query, limit = 5) {
  const client = getClient()
  const collection = getGoodsCollection(database)
  const result = await client.query(collection, {
    query: { text: query, model: embeddingModel },
    limit: Math.min(Math.max(limit, 1), 20),
    with_payload: true,
    with_vector: false,
  })
  return result.points.map(point => ({ score: point.score, ...point.payload }))
}

export async function listGoods(database) {
  const client = getClient()
  const collection = getGoodsCollection(database)
  const result = await client.scroll(collection, {
    limit: 1000,
    with_payload: true,
    with_vector: false,
  })
  return result.points
    .map(point => point.payload)
    .filter(Boolean)
    .sort((left, right) => Number(left.Id) - Number(right.Id))
}

export async function qdrantHealth(database) {
  const client = getClient()
  const collection = getGoodsCollection(database)
  const exists = await client.collectionExists(collection)
  if (!exists.exists) {
    return { connected: true, ready: false, collection, exists: false, pointsCount: 0, embeddingModel }
  }
  const collectionInfo = await client.getCollection(collection)
  return {
    connected: true,
    ready: true,
    collection,
    exists: true,
    pointsCount: Number(collectionInfo.points_count || 0),
    embeddingModel,
  }
}
