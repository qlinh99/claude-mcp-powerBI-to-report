# mcp-powerBI-to-report

MCP server tương thích Claude để khám phá workspace Fabric/Power BI, truy vấn semantic model, và trả lời dạng câu hỏi điều hành (executive) bằng cả văn bản lẫn báo cáo HTML độc lập (self-contained).

Repo này bọc quanh [`powerbi-modeling-mcp`](https://github.com/microsoft/powerbi-modeling-mcp) chính thức của Microsoft và hoàn toàn dựa vào cơ chế xác thực XMLA/TOM của công cụ đó (không dùng REST catalog login, không dùng device-login auth).

## Các tool

- `list_semantic_models_in_workspace`
- `get_known_workspace_catalog`
- `plan_multi_semantic_report`
- `execute_multi_semantic_report`
- `execute_dax_query`
- `execute_dax_report_query`
- `execute_dax_dashboard_query` (alias tương thích ngược)

## Cài đặt nhanh cho Claude Desktop

Yêu cầu có sẵn `git`, `node` (>= 18), và `npm` (>= 9) trên `PATH`. Các script cài đặt sẽ cài production dependencies, dùng bản build sẵn `dist/server.js`, ghi file `.env`, và merge server vào cấu hình `mcpServers` của Claude Desktop. **Đóng hẳn Claude Desktop (Quit từ system tray, không chỉ đóng cửa sổ) trước khi chạy các lệnh dưới đây** — nếu không Claude có thể ghi đè lại config trong lúc installer đang chỉnh sửa.

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/qlinh99/claude-mcp-powerBI-to-report/main/scripts/setup-claude-desktop.sh | bash -s -- --workspace GSM_MCP_POC_WORKSPACE
```

Chưa có Git/Node? Cài Homebrew rồi `brew install git node` trước, sau đó chạy lệnh trên.

### Windows (1 click — khuyến nghị cho người dùng phổ thông)

1. Tải file [`scripts/install.bat`](https://raw.githubusercontent.com/qlinh99/claude-mcp-powerBI-to-report/main/scripts/install.bat) về máy (click chuột phải vào link → "Save link as...").
2. Đóng hẳn Claude Desktop (Quit từ system tray).
3. Double-click file `install.bat` vừa tải.
4. Nhập tên workspace Power BI/Fabric khi được hỏi, nhấn Enter.

Script tự tải bản installer mới nhất, tự cài Git/Node.js qua `winget` nếu máy chưa có, clone repo về `%USERPROFILE%\mcp-powerBI-to-report`, cài dependencies, và ghi cấu hình vào Claude Desktop — không cần mở PowerShell hay gõ lệnh thủ công. Cửa sổ console sẽ giữ nguyên sau khi chạy xong để bạn đọc kết quả.

### Windows (PowerShell)

Dành cho ai muốn kiểm soát chi tiết hơn hoặc không tải được file `.bat` trực tiếp. Một lệnh — tự clone/cập nhật repo, cài dependencies, và cấu hình Claude Desktop:

```powershell
iwr -UseBasicParsing "https://raw.githubusercontent.com/qlinh99/claude-mcp-powerBI-to-report/main/scripts/install-windows.ps1" -OutFile "$env:TEMP\install-powerbi-mcp.ps1"
powershell -ExecutionPolicy Bypass -File "$env:TEMP\install-powerbi-mcp.ps1" -Workspace "GSM_MCP_POC_WORKSPACE"
```

Nếu đã có sẵn repo trên máy, chạy thẳng installer trong thư mục đó:

```powershell
cd <đường-dẫn-repo>
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Workspace "GSM_MCP_POC_WORKSPACE"
```

Các flag hữu ích của `install-windows.ps1`:

| Flag | Chức năng |
|---|---|
| `-RepoDir <path>` | Nơi clone/cập nhật repo (mặc định `~\mcp-powerBI-to-report`) |
| `-CorporateNpm` | Tạm thời set `npm_config_strict_ssl=false` cho mạng công ty có proxy kiểm tra SSL (tự khôi phục lại sau khi chạy xong). Chỉ dùng khi lệnh thường bị lỗi certificate/proxy. Không bỏ qua được các chặn ở gateway kiểu `403 MediaTypeBlocked` — cách đúng cho môi trường doanh nghiệp vẫn là dùng npm registry nội bộ, trusted CA (`npm cafile` / `NODE_EXTRA_CA_CERTS`), whitelist gateway, hoặc cấp phát binary Microsoft offline đã được duyệt. |
| `-Clean` | Xoá `node_modules` trước khi cài lại |
| `-SkipPrereqInstall` | Bỏ qua bước tự cài các phần mềm còn thiếu |

Nếu repo đã clone sẵn nhưng đang có thay đổi cục bộ (dirty working tree), hoặc bạn chỉ muốn cấu hình lại Claude Desktop mà không đụng tới repo, gọi thẳng script cấu hình:

```powershell
cd <đường-dẫn-repo>
npm install --omit=dev --include=optional
powershell -ExecutionPolicy Bypass -File scripts\setup-claude-desktop.ps1 -Workspace "GSM_MCP_POC_WORKSPACE"
```

Node.js portable: set `$env:NODE_PORTABLE_HOME` trước khi chạy nếu muốn dùng một bản Node cụ thể thay vì bản đang có trên `PATH`.

Kết quả thành công sẽ có dạng:

```text
Claude Desktop config updated: C:\Users\<you>\AppData\Roaming\Claude\claude_desktop_config.json
Local env written: C:\Users\<you>\mcp-powerBI-to-report\.env
Start Claude Desktop again, then use MCP server: mcp-powerBI-to-report
```

Trên Windows, tất cả installer đều thử tìm lệnh Modeling MCP theo thứ tự: `.exe` native -> `node_modules\.bin\powerbi-modeling-mcp.cmd` cục bộ -> `npx` (dự phòng).

### Nếu chính sách IT chặn cài đặt

Nhờ IT cài Git, Node.js LTS (đã bao gồm npm), và Claude Desktop, sau đó chạy lệnh cài đặt theo OS ở trên.

### Sau khi cài xong

Khởi động lại Claude Desktop, rồi hỏi:

```text
Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup.
```

Nếu chẩn đoán ổn:

```text
Use mcp-powerBI-to-report to list semantic models in workspace GSM_MCP_POC_WORKSPACE.
```

## Cài đặt thủ công

```bash
git clone https://github.com/qlinh99/claude-mcp-powerBI-to-report.git
cd claude-mcp-powerBI-to-report
npm install --omit=dev --include=optional
npm run setup
```

`npm run setup` sẽ hỏi tương tác về lệnh/tham số `powerbi-modeling-mcp` của Microsoft, danh sách tên workspace đã biết, workspace mặc định cho CEO, và các fallback tuỳ chọn cho semantic model/thư mục xuất báo cáo, sau đó ghi file `.env` cục bộ (quyền `0600`) mà server sẽ tự nạp khi khởi động.

Trên macOS, `npm install` cũng tự ad-hoc sign binary native Modeling MCP của Microsoft để Claude khởi chạy được mà không bị lỗi "unsigned binary" — chạy lại lệnh này nếu Claude Desktop báo lỗi khi khởi chạy.

Trên Windows, thứ tự tìm lệnh vẫn như trên: `node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe` -> `node_modules\.bin\powerbi-modeling-mcp.cmd` -> `npx`.

## Tham khảo cấu hình Claude Desktop

### 1. Vị trí file config

| OS | Đường dẫn |
|----|------|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows (chuẩn) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Windows (Store/MSIX) | `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json` |

> Đóng hẳn Claude Desktop trước khi tự tay sửa file này — nếu không Claude có thể ghi đè và làm mất `mcpServers`.

### 2. Mục mcpServers

Tối giản (dùng `.env` do `npm run setup` ghi ra):

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "node",
      "args": ["/absolute/path/to/claude-mcp-powerBI-to-report/dist/server.js"]
    }
  }
}
```

Cấu hình đầy đủ với env override tường minh:

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "node",
      "args": ["/absolute/path/to/claude-mcp-powerBI-to-report/dist/server.js"],
      "env": {
        "POWERBI_KNOWN_WORKSPACES": "your-workspace-name",
        "POWERBI_DEFAULT_WORKSPACE": "your-workspace-name",
        "POWERBI_DEFAULT_SEMANTIC_MODEL": "your-model-name",
        "POWERBI_MODELING_MCP_COMMAND": "/absolute/path/to/powerbi-modeling-mcp",
        "POWERBI_MODELING_MCP_ARGS": "--start --authmode=interactive",
        "POWERBI_REPORT_OUTPUT_DIR": "/absolute/path/to/powerbi-report-output"
      }
    }
  }
}
```

Giá trị `command`/`POWERBI_MODELING_MCP_COMMAND` theo từng nền tảng:

| Nền tảng | `command` | `POWERBI_MODELING_MCP_COMMAND` |
|---|---|---|
| macOS Apple Silicon | `/opt/homebrew/bin/node` | `.../node_modules/@microsoft/powerbi-modeling-mcp-darwin-arm64/dist/powerbi-modeling-mcp` |
| macOS Intel | `/usr/local/bin/node` | `.../node_modules/@microsoft/powerbi-modeling-mcp-darwin-x64/dist/powerbi-modeling-mcp` |
| Windows (exe native) | đường dẫn tuyệt đối tới `node.exe` | `...\node_modules\@microsoft\powerbi-modeling-mcp-win32-x64\dist\powerbi-modeling-mcp.exe` |
| Windows (shim cục bộ) | đường dẫn tuyệt đối tới `node.exe` | `...\node_modules\.bin\powerbi-modeling-mcp.cmd` |
| Windows (dự phòng npx) | đường dẫn tuyệt đối tới `node.exe` | `C:\Program Files\nodejs\npx.cmd` với args `-y @microsoft/powerbi-modeling-mcp@latest --start --authmode=interactive` |

> **Lưu ý Windows:** bridge chạy các lệnh `.cmd` và `npx` thông qua shell của Windows. Nếu thiếu điều đó, Node có thể lỗi `spawn npx ENOENT`.

File mẫu sẵn để chỉnh sửa: [`docs/claude-desktop-config.example.json`](docs/claude-desktop-config.example.json).

### 3. Phát triển cục bộ (không cần build)

```json
{
  "mcpServers": {
    "mcp-powerBI-to-report": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/claude-mcp-powerBI-to-report/src/server.ts"]
    }
  }
}
```

### 4. Agent tự cài đặt

```bash
npm run setup:agent -- --workspaces your-workspace-name
# hoặc ghi thẳng vào config Claude Desktop (tự động backup):
npm run setup:agent -- --workspaces your-workspace-name --write-desktop-config
```

## Xác thực (Authentication)

MCP này giao toàn bộ việc xác thực cho công cụ `@microsoft/powerbi-modeling-mcp` của Microsoft, thông qua chế độ auth tương tác (interactive) hoặc tham số tường minh trong `POWERBI_MODELING_MCP_ARGS`.

## Cách dùng

```text
Use mcp-powerBI-to-report to diagnose the local Power BI MCP setup.
Use mcp-powerBI-to-report to list semantic models in workspace test-mcp.
```

Tên workspace phải được biết trước và cung cấp rõ ràng — nếu thiếu, Claude nên hỏi lại thay vì đoán.

Với quy trình dành cho CEO, cấu hình:

```env
POWERBI_KNOWN_WORKSPACES=test-mcp
POWERBI_DEFAULT_WORKSPACE=test-mcp
# Chỉ là fallback tuỳ chọn. Nên để Claude tự chọn theo schema workspace.
# POWERBI_DEFAULT_SEMANTIC_MODEL=hospital
# Thư mục tuỳ chọn để chứa báo cáo HTML sinh ra.
# POWERBI_REPORT_OUTPUT_DIR=/path/to/powerbi-report-output
```

Sau đó Claude dùng `get_known_workspace_catalog` để liệt kê model, chọn model phù hợp theo schema/ngữ cảnh, và gọi `execute_dax_report_query` cho các câu hỏi nghiệp vụ. Wrapper giữ tiến trình Modeling MCP sống xuyên suốt phiên làm việc, nên các câu hỏi tiếp theo dùng lại cùng kết nối, tránh phải đăng nhập lại nhiều lần.

`execute_dax_report_query` trả về: tóm tắt văn bản, `insights`/`insightCards` (what/why/so-what/action/confidence/evidence), `dataProfile` (measure, dimension, số dòng/cột, các khoảng trống dữ liệu đã phát hiện), `nextQuestions`, `structuredContent` (rows, columns, HTML sinh ra), một resource `text/html` nhúng theo chuẩn MCP, và `reportPath`/`reportUri` để mở file đã sinh. Chỉ dùng `execute_dax_query` khi chỉ cần dữ liệu thô.

### Báo cáo điều hành đa semantic model

Một câu hỏi CEO có thể cần bằng chứng từ nhiều semantic model — ví dụ doanh thu nằm ở `sale_vehicle-vf`, còn chi phí campaign/lead nằm ở một model marketing riêng. Luồng khuyến nghị:

```text
câu hỏi → get_known_workspace_catalog → plan_multi_semantic_report
→ mỗi semantic model/vai trò bằng chứng viết một DAX query → execute_multi_semantic_report
→ trả lời văn bản + báo cáo HTML
```

`plan_multi_semantic_report` quyết định cần một hay nhiều model, ý định quyết định (`variance_decomposition`, `opportunity_prioritization`, `portfolio_decision`, `forecast_risk`), bằng chứng cần thiết, vai trò từng model, join grain/join key, các block cho ReportSpec, và cảnh báo khi thiếu bằng chứng hoặc không thể chứng minh quan hệ nhân quả.

`execute_multi_semantic_report` nhận nhiều DAX query:

```json
{
  "question": "Doanh thu VF tháng nào cao nhất và tại sao?",
  "grain": "Month x Province x Model",
  "joinKeys": ["Month", "Province", "Model"],
  "queries": [
    {
      "workspaceName": "test-mcp",
      "semanticModelName": "sale_vehicle-vf",
      "evidenceRole": "sales",
      "evidence": ["Revenue", "UnitsSold", "Model", "Province"],
      "query": "EVALUATE ..."
    },
    {
      "workspaceName": "test-mcp",
      "semanticModelName": "marketing-vf",
      "evidenceRole": "marketing",
      "evidence": ["CampaignSpend", "Leads", "ConversionRate"],
      "query": "EVALUATE ..."
    }
  ]
}
```

Các dòng dữ liệu được gắn nhãn `DataSource`, `WorkspaceName`, `SemanticModelName`, `EvidenceRole` và vẫn gộp chung trong `structuredContent.rows` phục vụ audit, nhưng báo cáo HTML giữ dataset của từng query tách riêng thay vì ép tất cả vào một biểu đồ — nó tự nhận diện hình dạng (shape) từng kết quả và render các block bằng chứng riêng cho từng dataset (nguồn dữ liệu/chất lượng, join grain/key/độ tin cậy, cảnh báo lệch grain, block time-series/ranking/cross-dimension, scorecard cho query quá đơn giản, và một bảng tổng hợp điều hành cho biết mỗi model chứng minh được gì, hỗ trợ quyết định gì, và còn thiếu bằng chứng nào).

**Lưu ý quan trọng:** nếu các semantic model không cùng grain với yêu cầu, báo cáo giữ ở chế độ tách nguồn (source-separated evidence) và mô tả các phát hiện xuyên nguồn là tương quan có định hướng (directional correlation), không phải quan hệ nhân quả đã chứng minh. Muốn so sánh/join trực tiếp các model, agent phải tự aggregate từng DAX query về cùng `joinKeys` trước (ví dụ `Month x Province x Model`).

### Tháng có doanh thu cực trị

Với các câu hỏi kiểu:

```text
Tháng nào có doanh thu thấp nhất, cao nhất và tại sao?
```

Nên dùng `execute_dax_report_query` và viết DAX trả về: một cột kỳ/tháng, một cột doanh thu dạng số, và các cột driver giải thích nếu model có (số đơn hàng, số khách hàng, giá trị đơn trung bình, sản phẩm/danh mục, khu vực, chi nhánh, kênh bán).

Report generator tự động phát hiện cột tháng và cột doanh thu, tổng hợp doanh thu theo tháng, và trả về tháng cao nhất/thấp nhất trong `summary` và `insights`. Với câu hỏi giải thích (`why`, `tại sao`, `vì sao`, cao nhất/thấp nhất), nó còn chạy một bước "evidence sufficiency gate" trước khi render:

- quét cột của semantic model bằng `INFO.COLUMNS()`
- suy luận các dimension sẵn có như `Region`, `Model`, `Province`, `Dealer`, `Campaign`
- suy luận các driver như units, ASP, margin, discount, marketing, inventory, market share
- suy luận kỳ (period) trọng tâm từ câu hỏi hoặc dữ liệu trả về
- chạy các query dò khoảng trống (slice gap) theo từng dimension và cross-dimension
- render mục `Evidence acquired before conclusion` cho biết đã truy vấn gì và phần schema nào thực sự còn thiếu

Báo cáo HTML còn có thêm lớp quyết định điều hành gồm `What happened`, `Why it happened`, `So what`, revenue bridge, driver tree, decision levers, run-rate read, và bảng bằng chứng. Nếu semantic model thiếu các trường như `Dealer`, `Campaign`, `Lead`, hoặc `Conversion`, báo cáo chỉ đánh dấu "thiếu" sau khi đã thực sự quét schema.

Ví dụ hình dạng DAX query:

```dax
EVALUATE
SUMMARIZECOLUMNS(
  'Date'[YearMonth],
  'Product'[Category],
  'Region'[RegionName],
  "Revenue", [Revenue],
  "Orders", [Orders],
  "Customers", [Customers],
  "Average Ticket", DIVIDE([Revenue], [Orders])
)
ORDER BY 'Date'[YearMonth]
```

## Chế độ vận hành cho CEO

- Giữ Claude Desktop và MCP server này chạy xuyên suốt phiên làm việc; tránh khởi động lại giữa các câu hỏi liên quan — câu hỏi đầu tiên trong phiên mới có thể kích hoạt xác thực Microsoft, các câu sau dùng lại kết nối sẵn có.
- Cấu hình `POWERBI_KNOWN_WORKSPACES` và `POWERBI_DEFAULT_WORKSPACE`. Coi `POWERBI_DEFAULT_SEMANTIC_MODEL` là fallback tuỳ chọn, không bắt buộc.
- Đặt câu hỏi nghiệp vụ bằng ngôn ngữ tự nhiên; Claude sẽ tự sinh DAX và gọi `execute_dax_report_query`.

## Kết quả báo cáo HTML

File HTML độc lập gồm: KPI card, câu trả lời điều hành/driver tree/revenue bridge/decision levers/run-rate read, các lớp insight `WHAT`/`WHY`/`SO WHAT`/`NOW WHAT`, phân tích đóng góp (contribution analysis), biểu đồ SVG tự chứa (line, combo bar+line, pie, donut, scatter, map) được chọn theo hình dạng dữ liệu, các "pocket" cross-dimension, mục theo dõi rủi ro/cơ hội, và các câu hỏi drill-down gợi ý tiếp theo — tuân theo quy tắc chọn biểu đồ gần giống Power BI (line cho time series, ranked bar cho tập category lớn, donut chỉ dùng cho tỷ lệ phần-tổng nhỏ, heatmap cho cross-dimension pocket, scatter chỉ khi đủ số điểm dữ liệu số, map chỉ khi có trường địa lý thật sự).

Dữ liệu thô vẫn có sẵn trong `structuredContent.rows` phục vụ audit/debug; các lần chạy đa semantic model còn expose thêm `structuredContent.datasets` và `structuredContent.datasetProfiles`.

File được ghi vào `POWERBI_REPORT_OUTPUT_DIR`, sau đó tới `POWERBI_DASHBOARD_OUTPUT_DIR` (để tương thích ngược), nếu không có thì ghi vào `./powerbi-report-output` tính từ thư mục làm việc của tiến trình MCP.

## Môi trường (Environment)

```bash
cp .env.example .env
set -a; source .env; set +a
npm run dev
```

## Ghi chú

- Bridge Modeling MCP của Microsoft mặc định dùng `npx -y @microsoft/powerbi-modeling-mcp@latest --start`. Override bằng `POWERBI_MODELING_MCP_COMMAND` / `POWERBI_MODELING_MCP_ARGS` nếu bạn có binary cục bộ đã ký (signed).
- Ghi chú kiểm thử cục bộ: [`docs/verification.md`](docs/verification.md).
