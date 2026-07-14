import { useEffect, useRef, useState } from 'react'
import './App.css'

const QUICK_PROMPTS = [
  ['Phân tích kinh doanh', 'Đánh giá mô hình kinh doanh hiện tại của tôi, chỉ ra 3 đòn bẩy tăng trưởng và kế hoạch ưu tiên 90 ngày.'],
  ['Tăng doanh thu', 'Đề xuất chiến lược tăng doanh thu thực tế trong 90 ngày, gồm các kênh, hành động, KPI và rủi ro.'],
  ['Kế hoạch Marketing', 'Lập kế hoạch marketing 90 ngày: mục tiêu, phân khúc, thông điệp, kênh, ngân sách và KPI.'],
  ['Khách hàng mục tiêu', 'Giúp tôi xác định chân dung khách hàng mục tiêu, nỗi đau, động lực mua và thông điệp phù hợp.'],
  ['Tối ưu vận hành', 'Phân tích các cơ hội tối ưu vận hành, giảm chi phí và tăng năng suất có thể triển khai ngay.'],
  ['Ứng dụng AI', 'Đề xuất lộ trình ứng dụng AI automation cho bán hàng, marketing và vận hành, ưu tiên theo ROI.'],
  ['KPI kinh doanh', 'Xây dựng dashboard KPI kinh doanh theo phễu: marketing, sales, doanh thu, lợi nhuận và vận hành.'],
  ['Phân tích đối thủ', 'Tạo khung phân tích đối thủ cạnh tranh, cách thu thập insight và chiến lược tạo khác biệt.'],
  ['Kế hoạch bán hàng', 'Lập kế hoạch bán hàng 90 ngày với mục tiêu, pipeline, vai trò, hoạt động tuần và KPI.'],
  ['Mở rộng quy mô', 'Đánh giá mức độ sẵn sàng mở rộng quy mô và xây lộ trình tăng trưởng bền vững.'],
]

const WELCOME = {
  role: 'assistant',
  content: 'Chào bạn, tôi là **Asia Nasa** — cố vấn chiến lược tăng trưởng. Hãy cho tôi biết doanh nghiệp, mục tiêu và thách thức hiện tại; tôi sẽ đề xuất hướng đi có thể triển khai ngay.',
}

function withoutThinking(content) {
  const lastThinkEnd = content.lastIndexOf('</think>')
  if (lastThinkEnd >= 0) return content.slice(lastThinkEnd + 8).trimStart()
  const thinkStart = content.indexOf('<think>')
  if (thinkStart >= 0) return content.slice(0, thinkStart).trimEnd()
  return content
}

function Icon({ name, size = 20 }) {
  const paths = {
    menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>, plus: <path d="M12 5v14M5 12h14" />,
    send: <path d="m21 3-6.5 18-3.7-7.8L3 9.5 21 3Zm-10.2 10.2L21 3" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></>,
    moon: <path d="M20.4 15.3A8.5 8.5 0 0 1 8.7 3.6 8.5 8.5 0 1 0 20.4 15.3Z" />,
    trash: <><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3" /></>,
    spark: <path d="m12 2 1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2Z" />,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}

function App() {
  const [messages, setMessages] = useState(() => JSON.parse(localStorage.getItem('asia-nasa-chat') || 'null') || [WELCOME])
  const [input, setInput] = useState('')
  const [models, setModels] = useState([])
  const [model, setModel] = useState(() => localStorage.getItem('asia-nasa-model') || '')
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem('asia-nasa-theme') || 'dark')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncStatus, setSyncStatus] = useState('')
  const [database, setDatabase] = useState(() => localStorage.getItem('asia-nasa-database') || 'isoft.asianasa.com')
  const bottomRef = useRef(null)

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('asia-nasa-theme', theme) }, [theme])
  useEffect(() => { localStorage.setItem('asia-nasa-chat', JSON.stringify(messages)) }, [messages])
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, loading])
  useEffect(() => {
    const savedDatabase = localStorage.getItem('asia-nasa-database') || 'isoft.asianasa.com'
    fetch(`/api/rag/health?database=${encodeURIComponent(savedDatabase)}`, { cache: 'no-store' }).then(r => r.json()).then(data => {
      setModels(data.model ? [data.model] : [])
      if (data.model) setModel(data.model)
      setConnected(Boolean(data.connected && data.exists))
    }).catch(() => setConnected(false))
  }, [])
  useEffect(() => { if (model) localStorage.setItem('asia-nasa-model', model) }, [model])
  useEffect(() => { localStorage.setItem('asia-nasa-database', database) }, [database])

  async function sendMessage(text = input) {
    const prompt = text.trim()
    if (!prompt || loading) return
    if (/^(hi|hello|hey|xin chào|chào|chào bạn)[!. ]*$/iu.test(prompt)) {
      setMessages(prev => [...prev, { role: 'user', content: prompt }, { role: 'assistant', content: 'Chào bạn! Tôi là trợ lý sản phẩm Asia Nasa. Bạn cần tìm sản phẩm hay kiểm tra giá bán?' }])
      setInput('')
      return
    }
    if (!model) { setMessages(prev => [...prev, { role: 'assistant', content: 'Không tìm thấy model Ollama. Hãy kiểm tra Ollama đang chạy và đã cài model Asia Nasa.' }]); return }
    const next = [...messages, { role: 'user', content: prompt }]
    const apiMessages = next.filter((message, index) => !(index === 0 && message.role === 'assistant' && message.content === WELCOME.content))
    setMessages([...next, { role: 'assistant', content: '' }]); setInput(''); setLoading(true)
    try {
      const response = await fetch('/api/rag/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ database: database.trim(), messages: apiMessages }) })
      if (!response.ok || !response.body) { const detail = await response.text(); throw new Error(detail || 'Không thể kết nối RAG API') }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let answer = ''; let buffer = ''
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        buffer += decoder.decode(value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop()
        for (const line of lines) if (line.trim()) { const data = JSON.parse(line); answer += data.message?.content || ''; setMessages([...next, { role: 'assistant', content: withoutThinking(answer) }]) }
      }
      setMessages([...next, { role: 'assistant', content: withoutThinking(answer) }])
    } catch (error) { setMessages([...next, { role: 'assistant', content: `**Không thể kết nối RAG.** Hãy kiểm tra backend, Qdrant và model trả lời.\n\nChi tiết: ${error.message}` }]) }
    finally { setLoading(false) }
  }

  async function rebuildGoodsModel() {
    if (syncing) return
    const selectedDatabase = database.trim()
    if (!selectedDatabase) { setSyncStatus('Hãy nhập tên database.'); return }
    setSyncing(true)
    setSyncStatus(`Đang đồng bộ ${selectedDatabase}...`)
    try {
      const response = await fetch('/api/rag/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ database: selectedDatabase }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Không thể đồng bộ Qdrant')
      const healthResponse = await fetch(`/api/rag/health?database=${encodeURIComponent(selectedDatabase)}`, { cache: 'no-store' })
      const health = await healthResponse.json()
      setModels(health.model ? [health.model] : [])
      if (health.model) setModel(health.model)
      setConnected(true)
      setSyncStatus(`Đã đồng bộ ${data.rows} sản phẩm vào ${data.collection}.`)
    } catch (error) {
      setSyncStatus(`Lỗi: ${error.message}`)
    } finally {
      setSyncing(false)
    }
  }

  function clearChat() { setMessages([WELCOME]); localStorage.removeItem('asia-nasa-chat') }
  return <div className="app-shell">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="brand"><div className="brand-mark"><Icon name="spark" /></div><div><strong>Asia Nasa</strong><span>Strategic Intelligence</span></div></div>
      <button className="new-chat" onClick={clearChat}><Icon name="plus" /> Cuộc trò chuyện mới</button>
      <div className="sidebar-section"><p>GỢI Ý CHIẾN LƯỢC</p><div className="prompt-list">{QUICK_PROMPTS.map(([label, prompt]) => <button key={label} onClick={() => { sendMessage(prompt); setSidebarOpen(false) }}><span>{label}</span><b>›</b></button>)}</div></div>
      <div className="model-sync"><label htmlFor="database-name">DATABASE</label><input id="database-name" value={database} onChange={event => setDatabase(event.target.value)} placeholder="isoft.asianasa.com" disabled={syncing} /><button onClick={rebuildGoodsModel} disabled={syncing || !database.trim()}><Icon name="spark" size={16} />{syncing ? 'Đang đồng bộ...' : 'Đồng bộ Qdrant'}</button>{syncStatus && <p>{syncStatus}</p>}</div>
      <div className="sidebar-footer"><span className={`status-dot ${connected ? 'online' : ''}`}></span>{connected ? 'Qdrant đã sẵn sàng' : 'Chưa có dữ liệu Qdrant'}</div>
    </aside>
    {sidebarOpen && <button className="backdrop" aria-label="Đóng menu" onClick={() => setSidebarOpen(false)} />}
    <main className="main">
      <header><button className="mobile-menu" onClick={() => setSidebarOpen(true)}><Icon name="menu" /></button><div className="model-select"><span className="pulse"></span><select value={model} onChange={e => setModel(e.target.value)} aria-label="Chọn model"><option value="">Chọn model</option>{models.map(name => <option key={name}>{name}</option>)}</select></div><div className="header-actions"><button title="Xóa hội thoại" onClick={clearChat}><Icon name="trash" size={18} /></button><button title="Đổi giao diện" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} /></button></div></header>
      <section className="conversation">{messages.map((message, index) => <article key={index} className={`message ${message.role}`}><div className="avatar">{message.role === 'assistant' ? <Icon name="spark" size={17} /> : 'Bạn'}</div><div className="message-body">{message.content ? <div className="message-content">{message.content}</div> : <div className="typing"><i></i><i></i><i></i></div>}</div></article>)}<div ref={bottomRef} /></section>
      <div className="composer-wrap"><div className="quick-row">{QUICK_PROMPTS.slice(0, 4).map(([label, prompt]) => <button key={label} onClick={() => sendMessage(prompt)}>{label}</button>)}</div><div className="composer"><textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }} placeholder="Trao đổi về chiến lược, tăng trưởng hay vận hành..." rows="1" disabled={loading} /><button className="send" onClick={() => sendMessage()} disabled={!input.trim() || loading}><Icon name="send" size={19} /></button></div><p className="hint">Asia Nasa có thể mắc lỗi. Hãy kiểm chứng các quyết định quan trọng. <kbd>Enter</kbd> để gửi</p></div>
    </main>
  </div>
}

export default App
