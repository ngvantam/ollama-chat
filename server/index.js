import 'dotenv/config'
import express from 'express'
import sql from 'mssql'
import { closePool, getPool, validateDatabaseName } from './db.js'
import { listGoods, qdrantHealth, searchGoods, syncGoodsToQdrant } from './qdrant.js'
import webProductChatRouter from './web-product-chat.js'

const app = express()
const port = Number(process.env.DB_PORT) || 3001
const ragModel = process.env.RAG_CHAT_MODEL || 'gemma3:1b'
const goodsAccount = String(process.env.GOODS_ACCOUNT || '1561').trim()
const goodsPriceList = String(process.env.GOODS_PRICE_LIST || 'BGC').trim()
const syncPromises = new Map()

app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))
app.use('/api', (_request, response, next) => {
  response.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.set('Pragma', 'no-cache')
  response.set('Expires', '0')
  next()
})
app.use('/api/web-product-chat', webProductChatRouter)

function selectedGoodsRequest(pool) {
  return pool.request()
    .input('goodsAccount', sql.NVarChar, goodsAccount)
    .input('goodsPriceList', sql.NVarChar, goodsPriceList)
    .query(`
      SELECT
        [Id], [Account], [AccountName], [PriceList], [Detail1], [DetailName1],
        [Detail2], [DetailName2], [SalePrice], [WebPriceVietNam],
        [OpeningStockQuantityNB], [Inventory], [StockUnit], [IsService], [ContentVietNam],
        [Status], [IsDeleted]
      FROM [dbo].[Goods]
      WHERE [Account] = @goodsAccount
        AND [PriceList] = @goodsPriceList
        AND [Status] = 1
        AND ([IsDeleted] = 0 OR [IsDeleted] IS NULL)
      ORDER BY [Id]
    `)
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/giu, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function isProductFactQuestion(prompt) {
  return /(giá|bao nhiêu|còn hàng|còn bao nhiêu|tồn kho)/iu.test(prompt)
}

function isKnowledgeReasoningQuestion(prompt) {
  return /(vitamin|dinh dưỡng|sức khỏe|đề kháng|bổ mắt|đẹp da|giảm cân|người già|trẻ em|tiểu đường|bà bầu|công dụng)/iu.test(prompt)
}

function compactProductCatalog(products) {
  const uniqueProducts = new Map()
  for (const product of products) {
    const name = product.DetailName2 || product.DetailName1
    if (!name || uniqueProducts.has(name)) continue
    uniqueProducts.set(name, {
      name,
      group: product.DetailName2 ? product.DetailName1 : undefined,
      description: product.ContentVietNam || undefined,
    })
  }
  return [...uniqueProducts.values()]
}

function findNamedProducts(rows, prompt) {
  const normalizedPrompt = ` ${normalizeText(prompt)} `
  const matches = rows
    .map(product => {
      const names = [product.DetailName2, product.DetailName1]
        .map(normalizeText)
        .filter(Boolean)
      const matchedLength = Math.max(0, ...names.map(name => normalizedPrompt.includes(` ${name} `) ? name.length : 0))
      return { product, matchedLength }
    })
    .filter(item => item.matchedLength > 0)

  if (!matches.length) return []
  const longestName = Math.max(...matches.map(item => item.matchedLength))
  return matches.filter(item => item.matchedLength === longestName).map(item => item.product)
}

function formatProductFacts(products) {
  const name = products[0].DetailName2 || products[0].DetailName1
  const lines = products.map(product => {
    const unit = product.StockUnit ? ` ${product.StockUnit}` : ''
    const priceUnit = product.StockUnit ? `/${product.StockUnit}` : ''
    const inventory = product.Inventory === null || product.Inventory === undefined || product.Inventory === ''
      ? 'chưa có dữ liệu tồn hiện tại'
      : `tồn hiện tại ${Number(product.Inventory).toLocaleString('vi-VN')}${unit}`
    const opening = product.OpeningStockQuantityNB === null || product.OpeningStockQuantityNB === undefined
      ? ''
      : `; tồn đầu kỳ ${Number(product.OpeningStockQuantityNB).toLocaleString('vi-VN')}${unit}`
    return `- Bảng giá ${product.PriceList || 'không xác định'}: giá bán ${Number(product.SalePrice).toLocaleString('vi-VN')}${priceUnit}; ${inventory}${opening}.`
  })
  const zeroPriceNote = products.some(product => Number(product.SalePrice) === 0)
    ? '\n\nGiá 0 ở trên là giá đang lưu trong đúng bảng giá đó, không phải giá do AI suy đoán.'
    : ''
  return `Thông tin “${name}” trong dữ liệu:\n${lines.join('\n')}${zeroPriceNote}`
}

app.post('/api/rag/sync', async (request, response) => {
  let database
  try {
    database = validateDatabaseName(request.body.database)
  } catch (error) {
    return response.status(400).json({ error: error.message })
  }
  const key = database.toLowerCase()
  if (syncPromises.has(key)) return response.status(409).json({ error: `Database ${database} đang được đồng bộ` })

  const syncPromise = (async () => {
    const pool = await getPool(database)
    const result = await selectedGoodsRequest(pool)
    return syncGoodsToQdrant(database, result.recordset)
  })()
  syncPromises.set(key, syncPromise)
  try {
    response.json({ database, ...(await syncPromise) })
  } catch (error) {
    console.error('Qdrant synchronization failed:', error.message)
    response.status(500).json({ error: error.message })
  } finally {
    syncPromises.delete(key)
  }
})

app.get('/api/rag/health', async (request, response) => {
  try {
    const database = validateDatabaseName(request.query.database)
    response.json({ ...(await qdrantHealth(database)), model: ragModel })
  } catch (error) {
    response.status(503).json({ connected: false, error: error.message, model: ragModel })
  }
})

app.post('/api/rag/search', async (request, response) => {
  try {
    const database = validateDatabaseName(request.body.database)
    const query = String(request.body.query || '').trim()
    if (!query) return response.status(400).json({ error: 'Query không được để trống' })
    response.json({ data: await searchGoods(database, query, request.body.limit || 5) })
  } catch (error) {
    response.status(500).json({ error: error.message })
  }
})

app.post('/api/rag/chat', async (request, response) => {
  try {
    const database = validateDatabaseName(request.body.database)
    const messages = Array.isArray(request.body.messages) ? request.body.messages.slice(-6) : []
    const prompt = String([...messages].reverse().find(message => message.role === 'user')?.content || '').trim()
    if (!prompt) return response.status(400).json({ error: 'Prompt không được để trống' })

    if (isProductFactQuestion(prompt)) {
      const pool = await getPool(database)
      const result = await selectedGoodsRequest(pool)
      const products = findNamedProducts(result.recordset, prompt)
      if (products.length) {
        const content = formatProductFacts(products)
        response.status(200).type('application/x-ndjson')
        response.end(`${JSON.stringify({ message: { role: 'assistant', content }, done: true })}\n`)
        return
      }
    }

    if (/(liệt kê|danh sách|những|các).{0,20}sản phẩm|sản phẩm.{0,20}(đang có|hiện có|gồm những gì)/iu.test(prompt)) {
      const products = await listGoods(database)
      const lines = products.map((product, index) => {
        const name = product.DetailName2 || product.DetailName1 || `Sản phẩm ${product.Id}`
        const price = Number(product.SalePrice).toLocaleString('vi-VN')
        return `${index + 1}. ${name} — giá ${price}${product.StockUnit ? `/${product.StockUnit}` : ''} — bảng giá ${product.PriceList || 'không xác định'}`
      })
      const content = `Có ${products.length} bản ghi sản phẩm trong dữ liệu:\n\n${lines.join('\n')}`
      response.status(200).type('application/x-ndjson')
      response.end(`${JSON.stringify({ message: { role: 'assistant', content }, done: true })}\n`)
      return
    }

    const knowledgeReasoning = isKnowledgeReasoningQuestion(prompt)
    const products = knowledgeReasoning
      ? compactProductCatalog(await listGoods(database))
      : await searchGoods(database, prompt, Number.parseInt(process.env.RAG_TOP_K || '5', 10))
    const context = knowledgeReasoning
      ? products.map(product => `- ${product.name}${product.group ? ` (nhóm ${product.group})` : ''}`).join('\n')
      : JSON.stringify(products, null, 2)
    const system = knowledgeReasoning
      ? `Bạn là trợ lý tư vấn sản phẩm. Hãy trả lời trực tiếp câu hỏi cuối cùng bằng tiếng Việt.

Dựa trên tên sản phẩm trong danh mục và kiến thức dinh dưỡng phổ thông, hãy chọn tối đa 5 sản phẩm phù hợp rồi giải thích ngắn gọn lý do. Ưu tiên thực phẩm thật sự liên quan như rau, củ, quả. Không chọn theo số thứ tự hoặc Id. Không lặp lại hướng dẫn hay toàn bộ danh mục.
Nếu hỏi vitamin A, ưu tiên rau lá xanh đậm và rau quả màu vàng/cam vì có thể chứa carotenoid tiền vitamin A; không mặc định nho hoặc táo là thực phẩm giàu vitamin A.
Câu đầu tiên phải nói dữ liệu sản phẩm không có hàm lượng vitamin nên chưa thể xác định loại nhiều nhất. Sau đó mới đưa ra gợi ý tham khảo. Không khẳng định sản phẩm cụ thể "giàu" hoặc "có nhiều" vitamin khi dữ liệu không xác nhận. Các gợi ý không phải thông tin dinh dưỡng chính thức của sản phẩm.

DANH_MỤC_SẢN_PHẨM:
${context}`
      : `Bạn là trợ lý sản phẩm Asia Nasa. Luôn trả lời bằng tiếng Việt, ngắn gọn và chỉ đưa kết quả cuối cùng.

Dữ liệu RAG bên dưới là nguồn chính thức cho tên, mã, giá và thuộc tính sản phẩm. SalePrice là giá bán. Khi trả giá, viết thành câu đầy đủ, nêu tên sản phẩm, định dạng số dễ đọc và kèm StockUnit nếu có; không tự suy đoán đơn vị tiền tệ. Nếu có nhiều bản ghi cùng tên, phải phân biệt theo PriceList, Account và Status, không tự chọn một giá. Không tự tạo dữ liệu kinh doanh không có trong nguồn. Không dùng Id, vị trí hay số thứ tự của kết quả RAG để trả lời sản phẩm nào tốt hơn hoặc nhiều hơn.
Nếu dữ liệu thiếu dinh dưỡng hoặc công dụng, có thể dùng kiến thức phổ thông nhưng phải ghi rõ là tham khảo và không tự tạo số liệu.
Không kết luận "tốt nhất" hoặc "nhiều nhất" nếu không có số liệu so sánh. Không chẩn đoán hay cam kết điều trị.

RAG_PRODUCT_DATA:
${context}`
    const ollamaResponse = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ragModel,
        messages: [{ role: 'system', content: system }, ...messages],
        stream: true,
        think: false,
        keep_alive: '30m',
        options: knowledgeReasoning ? { temperature: 0.2, num_predict: 220 } : undefined,
      }),
    })
    if (!ollamaResponse.ok || !ollamaResponse.body) {
      const detail = await ollamaResponse.text()
      throw new Error(`Ollama ${ollamaResponse.status}: ${detail}`)
    }
    response.status(200).type('application/x-ndjson')
    const reader = ollamaResponse.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      response.write(Buffer.from(value))
    }
    response.end()
  } catch (error) {
    console.error('RAG chat failed:', error.message)
    if (!response.headersSent) response.status(500).json({ error: error.message })
    else response.end()
  }
})

app.get('/api/db/health', async (request, response) => {
  try {
    const pool = await getPool(request.query.database || undefined)
    await pool.request().query('SELECT 1 AS ok')
    response.json({ connected: true })
  } catch {
    response.status(503).json({ connected: false, error: 'Database connection failed' })
  }
})

app.get('/api/db/goods', async (request, response) => {
  const requestedPage = Number.parseInt(request.query.page, 10)
  const requestedPageSize = Number.parseInt(request.query.pageSize, 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1
  const pageSize = Number.isFinite(requestedPageSize) ? Math.min(Math.max(requestedPageSize, 1), 100) : 25
  try {
    const pool = await getPool(request.query.database || undefined)
    const result = await pool.request()
      .input('offset', sql.Int, (page - 1) * pageSize)
      .input('pageSize', sql.Int, pageSize)
      .input('goodsAccount', sql.NVarChar, goodsAccount)
      .input('goodsPriceList', sql.NVarChar, goodsPriceList)
      .query(`
        SELECT * FROM [dbo].[Goods]
        WHERE [Account] = @goodsAccount
          AND [PriceList] = @goodsPriceList
          AND [Status] = 1
          AND ([IsDeleted] = 0 OR [IsDeleted] IS NULL)
        ORDER BY [Id]
        OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY;
        SELECT COUNT_BIG(1) AS total FROM [dbo].[Goods]
        WHERE [Account] = @goodsAccount
          AND [PriceList] = @goodsPriceList
          AND [Status] = 1
          AND ([IsDeleted] = 0 OR [IsDeleted] IS NULL);
      `)
    response.json({ data: result.recordsets[0], pagination: { page, pageSize, total: Number(result.recordsets[1][0].total) } })
  } catch {
    response.status(500).json({ error: 'Unable to load Goods' })
  }
})

const server = app.listen(port, () => console.log(`RAG API listening on http://localhost:${port}`))

async function shutdown() {
  server.close(async () => {
    await closePool().catch(() => undefined)
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
