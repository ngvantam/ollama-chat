# Asia Nasa Product RAG

Ứng dụng React + Express sử dụng SQL Server làm nguồn dữ liệu sản phẩm,
Qdrant Cloud để tìm kiếm ngữ nghĩa và một model Ollama nhẹ để diễn giải kết quả.
Sản phẩm không còn được nhúng vào Modelfile.

## Cấu hình

Sao chép `.env.example` thành `.env` và cấu hình:

```env
DB_CONNECTION_STRING=Server=...;Database={dbName};User Id=...;Password=...
DB_PORT=3001
DB_DEFAULT_DATABASE=isoft.asianasa.com

QDRANT_URL=https://your-cluster.cloud.qdrant.io
QDRANT_API_KEY=your-rotated-qdrant-api-key
QDRANT_EMBEDDING_MODEL=sentence-transformers/all-MiniLM-L6-v2
QDRANT_VECTOR_SIZE=384

RAG_CHAT_MODEL=gemma3:1b
RAG_TOP_K=5
GOODS_ACCOUNT=1561
GOODS_PRICE_LIST=BGC
PRODUCT_CHAT_DATABASES=isoft.asianasa.com,bh0288,test.asianasa.com
```

Không commit `.env` hoặc đặt API key trong README/source code. Bật Inference trong
Qdrant Cloud Console và kiểm tra model embedding đã chọn có nhãn Free.

## Chạy ứng dụng

```powershell
cd D:\AI_Ollama\ollama-chat
npm install
npm run server
```

Mở terminal khác:

```powershell
cd D:\AI_Ollama\ollama-chat
npm run dev
```

Sau khi mở UI, nhập database và bấm **Đồng bộ Qdrant**. Mỗi database được lưu
trong một collection riêng. Đồng bộ không dùng `TOP`, nhưng chỉ lấy bản ghi có
`Account = GOODS_ACCOUNT`, `PriceList = GOODS_PRICE_LIST`, `Status = 1` và chưa
bị xóa (`IsDeleted = 0` hoặc `NULL`).

## API

- `POST /api/rag/sync` — đồng bộ SQL sang Qdrant.
- `GET /api/rag/health?database=isoft.asianasa.com` — trạng thái collection.
- `POST /api/rag/search` — kiểm tra kết quả truy xuất.
- `POST /api/rag/chat` — retrieve Top-K rồi stream câu trả lời.
- `GET /api/db/health`
- `GET /api/db/goods?page=1&pageSize=25`

## API riêng cho WEBONEPAGE

WEBONEPAGE lấy database từ `environment.dbName` và gửi database đó trong mọi
request. Mỗi database dùng một collection Qdrant riêng, ví dụ
`goods_isoft_asianasa_com` hoặc `goods_bh0288`.

- `GET /api/web-product-chat/status?database=...` — kiểm tra collection và số sản phẩm.
- `POST /api/web-product-chat/sync` — đọc lại Goods rồi thay dữ liệu collection của database.
- `POST /api/web-product-chat/chat` — chat theo đúng collection của database gửi lên.

`PRODUCT_CHAT_DATABASES` là danh sách database được phép sử dụng chatbot, phân
cách bằng dấu phẩy. Để trống trong môi trường development nếu chưa cần giới hạn.
Production nên khai báo rõ danh sách database và đặt API sau reverse proxy nội bộ.

Angular development proxy chuyển `/rag-api` sang `http://localhost:3001/api`.
Khi deploy WEBONEPAGE, web server cũng cần cấu hình reverse proxy cùng đường dẫn
hoặc thay bằng URL backend chatbot phù hợp.

Qdrant chỉ tạo embedding và truy xuất sản phẩm liên quan; `RAG_CHAT_MODEL` chịu
trách nhiệm viết câu trả lời cuối cùng. Có thể đổi model này mà không cần đồng bộ
lại Qdrant.


netstat -ano | findstr :3001
taskkill /PID 10212 /F

npm install --legacy-peer-deps
npm.cmd start
npm.cmd run build
D:\A.Hung_Cong\resource\WEBONEPAGE>.\node_modules\.bin\ng.cmd serve
 
ollama pull gemma3:1b
