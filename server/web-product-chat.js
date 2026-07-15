import express from 'express'
import sql from 'mssql'
import { getPool, validateDatabaseName } from './db.js'
import { qdrantHealth, searchGoods, syncGoodsToQdrant } from './qdrant.js'

const router = express.Router()
const ragModel = process.env.RAG_CHAT_MODEL || 'gemma3:1b'
const goodsAccount = String(process.env.GOODS_ACCOUNT || '1561').trim()
const goodsPriceList = String(process.env.GOODS_PRICE_LIST || 'BGC').trim()
const syncTasks = new Map()
const syncStates = new Map()

function validateWebsiteDatabase(value) {
  const database = validateDatabaseName(value)
  const configuredDatabases = String(process.env.PRODUCT_CHAT_DATABASES || '')
    .split(',')
    .map(item => item.trim().toLowerCase())
    .filter(Boolean)

  if (configuredDatabases.length && !configuredDatabases.includes(database.toLowerCase())) {
    throw new Error(`Database ${database} không được phép sử dụng chatbot`)
  }

  return database
}

function selectWebsiteGoods(database) {
  return getPool(database).then(pool => pool.request()
    .input('goodsAccount', sql.NVarChar, goodsAccount)
    .input('goodsPriceList', sql.NVarChar, goodsPriceList)
    .query(`
      SELECT
        [Id], [Account], [AccountName], [PriceList], [Detail1], [DetailName1],
        [Detail2], [DetailName2], [SalePrice], [WebPriceVietNam],
        [OpeningStockQuantityNB], [Inventory], [StockUnit], [IsService],
        [ContentVietNam], [WebGoodNameVietNam], [Status], [IsDeleted]
      FROM [dbo].[Goods]
      WHERE [Account] = @goodsAccount
        AND [PriceList] = @goodsPriceList
        AND [Status] = 1
        AND ([IsDeleted] = 0 OR [IsDeleted] IS NULL)
      ORDER BY [Id]
    `))
}

function selectWebsiteGoodById(database, productId) {
  return getPool(database).then(pool => pool.request()
    .input('goodsAccount', sql.NVarChar, goodsAccount)
    .input('goodsPriceList', sql.NVarChar, goodsPriceList)
    .input('productId', sql.Int, productId)
    .query(`
      SELECT TOP 1
        [Id], [Account], [AccountName], [PriceList], [Detail1], [DetailName1],
        [Detail2], [DetailName2], [SalePrice], [WebPriceVietNam],
        [OpeningStockQuantityNB], [Inventory], [StockUnit], [IsService],
        [ContentVietNam], [WebGoodNameVietNam], [Status], [IsDeleted]
      FROM [dbo].[Goods]
      WHERE [Id] = @productId
        AND [Account] = @goodsAccount
        AND [PriceList] = @goodsPriceList
        AND [Status] = 1
        AND ([IsDeleted] = 0 OR [IsDeleted] IS NULL)
    `))
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

function findNamedProducts(products, prompt) {
  const normalizedPrompt = ` ${normalizeText(prompt)} `
  const matches = products.map(product => {
    const names = [product.DetailName2, product.DetailName1]
      .map(normalizeText)
      .filter(Boolean)
    const matchedLength = Math.max(0, ...names.map(name =>
      normalizedPrompt.includes(` ${name} `) ? name.length : 0))
    return { product, matchedLength }
  }).filter(item => item.matchedLength > 0)

  if (!matches.length) return []
  const longestName = Math.max(...matches.map(item => item.matchedLength))
  return matches.filter(item => item.matchedLength === longestName).map(item => item.product)
}

function formatProductFacts(products) {
  const name = products[0].DetailName2 || products[0].DetailName1
  const lines = products.map(product => {
    const stockUnit = product.StockUnit ? ` ${product.StockUnit}` : ''
    const priceUnit = product.StockUnit ? `/${product.StockUnit}` : ''
    const inventory = product.Inventory === null || product.Inventory === undefined || product.Inventory === ''
      ? 'chưa có dữ liệu tồn hiện tại'
      : `tồn hiện tại ${Number(product.Inventory).toLocaleString('vi-VN')}${stockUnit}`
    return `- Giá bán ${Number(product.SalePrice).toLocaleString('vi-VN')}${priceUnit}; ${inventory}.`
  })
  return `Thông tin “${name}” trong dữ liệu:\n${lines.join('\n')}`
}

function formatShortDescription(value) {
  const description = String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (description.length <= 140) return description
  return `${description.slice(0, 137).trim()}...`
}

function formatProductCards(products) {
  const cards = []
  const productIds = new Set()
  for (const product of products) {
    const productId = Number(product.Id)
    if (!Number.isInteger(productId) || productIds.has(productId)) continue
    productIds.add(productId)

    const inventory = product.Inventory === null || product.Inventory === undefined || product.Inventory === ''
      ? null
      : Number(product.Inventory)
    const price = Number(product.SalePrice || 0)
    cards.push({
      productId,
      name: product.WebGoodNameVietNam || product.DetailName2 || product.DetailName1 || `Sản phẩm ${productId}`,
      price,
      shortDescription: formatShortDescription(product.ContentVietNam),
      stockStatus: inventory === null ? 'Chưa có dữ liệu tồn kho' : inventory > 0 ? 'Còn hàng' : 'Hết hàng',
      availableQuantity: inventory,
      stockUnit: product.StockUnit || '',
      action: {
        addToCart: inventory !== null && inventory > 0 && price > 0,
        viewDetail: `/product-detail/${productId}`,
      },
    })
  }
  return cards
}

function sendChatMessage(response, content, products = []) {
  response.status(200).type('application/x-ndjson')
  response.end(`${JSON.stringify({
    message: { role: 'assistant', content },
    products: formatProductCards(products),
    done: true,
  })}\n`)
}

function isProductFactQuestion(prompt) {
  return /(giá|bao nhiêu|còn hàng|còn bao nhiêu|tồn kho)/iu.test(prompt)
}

function isGreeting(prompt) {
  return /^(hi|hello|hey|xin chào|chào|chào bạn|alo)[!,.? ]*$/iu.test(prompt)
}

function getConversationReply(prompt) {
  if (isGreeting(prompt)) {
    return 'Xin chào! Tôi là Asia Nasa. Tôi có thể giúp gì cho bạn về sản phẩm, giá bán hoặc tồn kho?'
  }

  if (/^((ok|okay)[,. ]+)?((cảm|cám) ơn( bạn)?( rất nhiều| nhiều)?|thank you|thanks)[!,.? ]*$/iu.test(prompt)) {
    return 'Rất vui vì Asia Nasa đã hỗ trợ được bạn. Nếu cần thêm thông tin về sản phẩm, giá bán hoặc tồn kho, bạn cứ hỏi tôi nhé!'
  }

  if (/^(tạm biệt|chào nhé|hẹn gặp lại|bye|goodbye)[!,.? ]*$/iu.test(prompt)) {
    return 'Tạm biệt bạn! Asia Nasa luôn sẵn sàng hỗ trợ khi bạn cần. Chúc bạn một ngày tốt lành!'
  }

  return ''
}

function isProductListQuestion(prompt) {
  return /(liệt kê|danh sách|những|các).{0,20}sản phẩm|sản phẩm.{0,20}(đang có|hiện có|gồm những gì)/iu.test(prompt)
}

function isKnowledgeQuestion(prompt) {
  return /(vitamin|dinh dưỡng|sức khỏe|đề kháng|bổ mắt|đẹp da|giảm cân|người già|trẻ em|tiểu đường|bà bầu|công dụng)/iu.test(prompt)
}

function compactProductCatalog(products) {
  const names = new Set()
  for (const product of products) {
    const name = product.DetailName2 || product.DetailName1
    if (name) names.add(name)
  }
  return [...names].map(name => `- ${name}`).join('\n')
}

async function streamOllamaResponse(response, messages, context, knowledgeQuestion, recommendedProducts) {
  const system = knowledgeQuestion
    ? `Bạn là trợ lý tư vấn sản phẩm cho khách hàng Việt Nam. Chỉ được trả lời bằng tiếng Việt. Tuyệt đối không dùng tiếng Trung, tiếng Nhật hoặc tiếng Hàn. Trả lời trực tiếp, tự nhiên và phù hợp với ngữ cảnh hội thoại. Dựa trên tên sản phẩm trong danh mục và kiến thức phổ thông, gợi ý tối đa 5 sản phẩm phù hợp. Không dùng Id hoặc số thứ tự. Nếu không có dữ liệu định lượng thì không xếp hạng tuyệt đối và phải nói rõ nội dung dinh dưỡng chỉ là tham khảo. Không được tạo tên sản phẩm không có trong danh mục.\n\nDANH_MỤC_SẢN_PHẨM:\n${context}`
    : `Bạn là trợ lý sản phẩm cho khách hàng Việt Nam. Chỉ được trả lời bằng tiếng Việt. Tuyệt đối không dùng tiếng Trung, tiếng Nhật hoặc tiếng Hàn. Trả lời tự nhiên theo ngữ cảnh, ngắn gọn và chỉ đưa kết quả cuối cùng. Dữ liệu bên dưới là nguồn chính thức cho tên, mã, giá và thuộc tính sản phẩm. SalePrice là giá bán. Không tự tạo dữ liệu kinh doanh. Không dùng Id hoặc số thứ tự để kết luận sản phẩm nào tốt hơn.\n\nRAG_PRODUCT_DATA:\n${context}`

  const ollamaResponse = await fetch('http://localhost:11434/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ragModel,
      messages: [{ role: 'system', content: system }, ...messages],
      stream: true,
      think: false,
      keep_alive: '30m',
      options: knowledgeQuestion ? { temperature: 0.2, num_predict: 220 } : undefined,
    }),
  })

  if (!ollamaResponse.ok || !ollamaResponse.body) {
    const detail = await ollamaResponse.text()
    throw new Error(`Ollama ${ollamaResponse.status}: ${detail}`)
  }

  response.status(200).type('application/x-ndjson')
  const reader = ollamaResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let hasValidContent = false
  let invalidLanguage = false
  while (true) {
    const stream = await reader.read()
    if (stream.done) break
    buffer += decoder.decode(stream.value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.trim()) continue
      const chatResponse = JSON.parse(line)
      if (chatResponse?.done) continue
      const content = String(chatResponse?.message?.content || '')
      if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(content)) {
        invalidLanguage = true
        continue
      }
      if (content.trim()) hasValidContent = true
      response.write(`${line}\n`)
    }
  }

  if (buffer.trim()) {
    const chatResponse = JSON.parse(buffer)
    const content = String(chatResponse?.message?.content || '')
    if (chatResponse?.done) {
      buffer = ''
    } else if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(content)) {
      invalidLanguage = true
    } else {
      if (content.trim()) hasValidContent = true
      response.write(`${buffer}\n`)
    }
  }

  if (invalidLanguage && !hasValidContent) {
    response.write(`${JSON.stringify({
      message: {
        role: 'assistant',
        content: 'Xin lỗi, tôi chưa thể diễn đạt câu trả lời phù hợp bằng tiếng Việt. Bạn vui lòng hỏi lại theo cách khác nhé!',
      },
      products: formatProductCards(recommendedProducts),
      done: true,
    })}\n`)
  } else {
    response.write(`${JSON.stringify({
      message: { role: 'assistant', content: '' },
      products: formatProductCards(recommendedProducts),
      done: true,
    })}\n`)
  }
  response.end()
}

router.get('/status', async (request, response) => {
  try {
    const database = validateWebsiteDatabase(request.query.database)
    const qdrant = await qdrantHealth(database)
    const syncState = syncStates.get(database.toLowerCase())
    response.json({ database, model: ragModel, ...qdrant, ...syncState })
  } catch (error) {
    response.status(503).json({ ready: false, error: error.message })
  }
})

router.post('/sync', async (request, response) => {
  let database
  try {
    database = validateWebsiteDatabase(request.body.database)
  } catch (error) {
    return response.status(400).json({ error: error.message })
  }

  const databaseKey = database.toLowerCase()
  if (syncTasks.has(databaseKey)) {
    return response.status(409).json({ error: `Database ${database} đang được đồng bộ` })
  }

  const syncTask = (async () => {
    syncStates.set(databaseKey, { syncing: true })
    const goods = await selectWebsiteGoods(database)
    const qdrant = await syncGoodsToQdrant(database, goods.recordset)
    const state = {
      syncing: false,
      ready: true,
      rows: qdrant.rows,
      updatedAt: new Date().toISOString(),
    }
    syncStates.set(databaseKey, state)
    return { database, ...qdrant, ...state }
  })()

  syncTasks.set(databaseKey, syncTask)
  try {
    response.json(await syncTask)
  } catch (error) {
    syncStates.set(databaseKey, { syncing: false, ready: false, error: error.message })
    response.status(500).json({ error: error.message })
  } finally {
    syncTasks.delete(databaseKey)
  }
})

router.post('/cart/add', async (request, response) => {
  try {
    const database = validateWebsiteDatabase(request.body.database)
    const productId = Number(request.body.productId)
    const quantity = Number(request.body.quantity)
    if (!Number.isInteger(productId) || productId <= 0) {
      return response.status(400).json({ error: 'productId không hợp lệ' })
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      return response.status(400).json({ error: 'Số lượng không hợp lệ' })
    }

    const goods = await selectWebsiteGoodById(database, productId)
    const product = goods.recordset[0]
    if (!product) {
      return response.status(404).json({ error: 'Sản phẩm không tồn tại hoặc đã ngừng bán' })
    }

    const inventory = product.Inventory === null || product.Inventory === undefined || product.Inventory === ''
      ? null
      : Number(product.Inventory)
    if (inventory === null) {
      return response.status(409).json({ error: 'Sản phẩm chưa có dữ liệu tồn kho' })
    }
    if (inventory < quantity) {
      return response.status(409).json({ error: 'Sản phẩm không đủ số lượng tồn kho' })
    }
    if (Number(product.SalePrice || 0) <= 0) {
      return response.status(409).json({ error: 'Sản phẩm chưa có giá bán hợp lệ' })
    }

    response.json({
      success: true,
      database,
      quantity,
      product: formatProductCards([product])[0],
    })
  } catch (error) {
    response.status(500).json({ error: error.message })
  }
})

router.post('/chat', async (request, response) => {
  try {
    const database = validateWebsiteDatabase(request.body.database)
    const messages = Array.isArray(request.body.messages) ? request.body.messages.slice(-6) : []
    const prompt = String([...messages].reverse().find(message => message.role === 'user')?.content || '').trim()
    if (!prompt) return response.status(400).json({ error: 'Prompt không được để trống' })

    const conversationReply = getConversationReply(prompt)
    if (conversationReply) {
      sendChatMessage(response, conversationReply)
      return
    }

    if (syncTasks.has(database.toLowerCase())) {
      return response.status(409).json({ error: `Database ${database} đang được đồng bộ dữ liệu sản phẩm` })
    }
    const qdrant = await qdrantHealth(database)
    if (!qdrant.exists) {
      return response.status(409).json({ error: `Database ${database} chưa được đồng bộ dữ liệu sản phẩm` })
    }

    if (isProductFactQuestion(prompt)) {
      const goods = await selectWebsiteGoods(database)
      const products = findNamedProducts(goods.recordset, prompt)
      if (products.length) {
        sendChatMessage(response, formatProductFacts(products), products)
        return
      }
    }

    if (isProductListQuestion(prompt)) {
      const goods = await selectWebsiteGoods(database)
      const products = goods.recordset
      sendChatMessage(response, `Có ${products.length} sản phẩm trong dữ liệu:`, products)
      return
    }

    const knowledgeQuestion = isKnowledgeQuestion(prompt)
    const products = await searchGoods(database, prompt, Number.parseInt(process.env.RAG_TOP_K || '5', 10))
    const context = knowledgeQuestion
      ? compactProductCatalog(products)
      : JSON.stringify(products, null, 2)

    const goods = await selectWebsiteGoods(database)
    const currentProducts = new Map(goods.recordset.map(product => [Number(product.Id), product]))
    const recommendedProducts = products
      .map(product => currentProducts.get(Number(product.Id)))
      .filter(Boolean)

    await streamOllamaResponse(response, messages, context, knowledgeQuestion, recommendedProducts)
  } catch (error) {
    console.error('Web product chat failed:', error.message)
    if (!response.headersSent) response.status(500).json({ error: error.message })
    else response.end()
  }
})

export default router
