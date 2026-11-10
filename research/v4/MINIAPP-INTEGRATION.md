# Miniapp → Open V4 Quorum

Ngày 2026-11-10. Đã có mã tích hợp local. Không có địa chỉ V4 public đã deploy được xác minh trong công việc này; không tự dùng CA V2 `0x53b5…7779` làm CA V4. Không đổi Vercel, Supabase thật hay gửi giao dịch public.

## Phạm vi đã nối

| Luồng | Nguồn dữ liệu và thao tác |
|---|---|
| Cast / phiên 24 giờ | Farcaster Quick Auth xác minh FID; Neynar xác minh cast và ví verified; thời gian/cohort lấy từ Base; bảng V4 riêng, khôi phục bằng cast hash/link |
| Mining claim | Đọc `dayInfo`, certificate, `allocations`; gọi trực tiếp distributor `claim(day)`; không voucher signer hoặc số dư local |
| Trạng thái | Phân biệt phiên đang chạy, chờ report, công bố allocations, review, mở claim, đã claim, hết hạn, tranh chấp, lỡ deadline |
| Stake | Approve đúng lượng cần, stake/withdraw, total staked, khóa 30 ngày, activate voting power, claim và finalize epoch |
| DAO | Đọc checkpoint power/Yes/No; chốt tháng, mở vote, vote, settle, claim air và trả reserve air quá hạn |
| Token / Network | Số dư/cung thực, cumulative minted, daily pool, active bond, 5 địa chỉ contract và explorer đúng chain |
| Xác nhận ví | Simulation trước gửi, kiểm tra account/network, chỉ báo thành công sau receipt đúng from/to/calldata và status success; timeout lưu tx để kiểm tra lại |

V4 dùng ABI sinh từ Solidity Open V4 hiện tại (`npm run v4:app-abi`). Không dùng ABI Nitro/research đời trước. App kiểm tra chain ID, các liên kết token/distributor/staking/treasury/registry, policy hash và bootstrap admin đã xóa trước khi cho ghi. Việc đó không thay thế kiểm tra runtime/artifact bằng `verify-open-deployment.mjs` trước triển khai.

Portal quản trị `ops.html` vẫn đọc ledger legacy; công việc này đồng bộ miniapp, không biến portal cũ thành dashboard node V4.

Countdown tính lại từ timestamp sau khi quay lại app và đồng bộ Base/session server, không phụ thuộc thiết bị cũ còn mở. Claim/stake/DAO không gọi backend ký phép. Khi backend intake offline, có thể nhập mining day / epoch / tháng để đọc và claim trực tiếp.

Giữ luật đã yêu cầu: claim phiên cũ xong mới mở phiên mới. Phiên hết hạn, không được phân bổ, report tranh chấp hoặc quá hạn kết quả không khóa người dùng mãi. Vì V4 có review 48 giờ, luật này khiến người dùng phải chờ nhiều hơn 24 giờ giữa các phiên. Chưa tự đổi thành được mở phiên mỗi 24 giờ trong khi chờ claim.

Không còn hiển thị reward cố định 386.03 trước mining: số thưởng chỉ xác định khi có report/allocations. Pool hiển thị theo ngày onchain, mỗi miner tối đa 1% pool; không tính balance browser là tiền rút được. Tab Squad/referral V2 không đưa vào V4 vì policy Open V4 hiện tại không có thưởng referral.

## Thời gian đúng theo contract

- Một phiên 24 giờ, cohort theo mốc launch bất biến (không phải giờ điện thoại).
- Report sớm nhất sau cuối cohort +24 giờ +6 giờ, rồi review 48 giờ. Cohort 0 sớm nhất mở claim ở launch +4 ngày 6 giờ.
- Ai cũng có thể `activateDay` sau publication đầy đủ và review. Cửa sổ mining claim **24 giờ cho toàn cohort** bắt đầu từ giao dịch này, không tính riêng từ lúc mỗi người mở app. UI báo deadline cụ thể.
- Stake: khóa 30 ngày; top-up reset toàn bộ lock. Quyền vote phải activate trước snapshot mở round. Thưởng stake theo epoch 30 ngày, claim 90 ngày.
- Tháng lẻ air, tháng chẵn burn. Chốt tháng sớm nhất ngày 11 UTC; mở round trong khoảng contract cho phép, thực tế ngày 11–21; vote 7 ngày, thắng chờ 72 giờ. Air dựa số mining thực claim của **cohort tháng trước**, claim 90 ngày. Không dùng lịch 1/15 cũ.

## Bật bản V4 khi đã deploy

1. Triển khai/verify 5 contract theo `OPEN-V4-READINESS.md`; chốt distributor và có node đủ cọc hoạt động. Chạy thử public Sepolia trước khi chuyển mainnet.
2. Chạy toàn bộ `supabase/migrations/20261110_v4_mining_sessions.sql` trong SQL Editor của Supabase. Migration không xóa/sửa ledger V2. Có thể chạy lại. Test local PostgreSQL không đồng nghĩa đã chạy migration production.
3. Thêm biến môi trường Vercel. Các cặp sau phải cùng địa chỉ/mạng thực:

| Frontend (public, build time) | Backend (server only) |
|---|---|
| `VITE_V4_CHAIN_ID` | `V4_CHAIN_ID` |
| `VITE_V4_TOKEN_ADDRESS` | `V4_TOKEN_ADDRESS` |
| `VITE_V4_DISTRIBUTOR_ADDRESS` | `V4_DISTRIBUTOR_ADDRESS` |
| `VITE_V4_STAKING_ADDRESS` | `V4_STAKING_ADDRESS` |
| `VITE_V4_DAO_ADDRESS` | `V4_DAO_ADDRESS` |
| `VITE_V4_REGISTRY_ADDRESS` | `V4_REGISTRY_ADDRESS` |
| `VITE_V4_RPC_URL` (tùy chọn) | `V4_RPC_URL` (tùy chọn) |

Chain `84532` = Base Sepolia, `8453` = Base mainnet. RPC phía browser phải là endpoint cho phép public, không đặt khóa bí mật trong biến `VITE_*`. Backend dùng các biến Supabase/Neynar/Quick Auth đã có; không cần `CLAIM_SIGNER_PRIVATE_KEY` cho claim V4. Giữ cấu hình legacy nếu vẫn phục vụ API V2.

4. Đặt `VITE_MINING_PROTOCOL=v4`, build/deploy lại. Mặc định vẫn là `legacy` để bản live tiếp tục hoạt động. Thiếu địa chỉ V4 sẽ hiện trang chưa cấu hình và khóa chức năng, không quay sang mint contract cũ. V2 token/history không tự đổi thành V4 token/history.
5. Kiểm tra trên Farcaster điện thoại: connect → post (được sửa text/thêm ảnh trong composer) → trở về thấy phiên → reload/thiết bị khác → report được node hoàn thiện → claim → số dư explorer đúng → stake → đủ 30 ngày activate vote. Nếu callback cast mất, paste link trong “Already posted?” để xác minh lại, không phải post thêm.

## Intake và phần node còn phải vận hành

`GET /api/v4/mining` yêu cầu Quick Auth; trả phiên và eligibility theo đúng chain/distributor/FID. `POST` nhận `{chainId, distributor, walletAddress, castHash}` hoặc `castUrl`. Không nhận reward, follower count, day, FID hoặc timer từ browser. Unique constraints chống cast replay, trùng FID/ví trong cohort; khóa giao dịch DB chống hai phiên chồng nhau. Một FID gắn một ví payout trong deployment này; đây là hạn chế intake, không tuyên bố là luật global của mọi node/miniapp.

`GET /api/v4/mining?action=cohort&day=0&offset=0` là nguồn observations public cho node, tối đa 100 bản ghi/trang. Mỗi bản ghi công khai FID, payout wallet, cast hash, start/end. Theo `nextOffset` tới null; chỉ lấy snapshot sau cohort đã đóng. Dữ liệu này **không phải bằng chứng nguồn hay report được quorum chứng thực**. Node phải tự xác minh cast, FID/ví, thời điểm, follower và công việc node, kiểm tra đầy đủ danh sách, rồi dùng `open-report.mjs` để tính cùng report; lưu input bền vững, chống ký hai digest cho một ngày và nộp đúng các bước `submitSignatures` → `publishAllocations` → review → `activateDay`.

**Bản tích hợp miniapp không tự tạo worker quorum production.** Các file `research/v4/node/work.mjs`/`relay-report.mjs` thuộc nghiên cứu proof/Nitro cũ, không tương thích với chữ ký Open V4; đừng chạy chúng rồi kỳ vọng claim Open V4 mở. Muốn mining V4 end-to-end trên mạng thật phải hoàn thiện/vận hành collector, validator signer và relayer Open V4 theo giao diện trên. Nếu không có report hợp lệ, app báo chờ hoặc quá hạn, tuyệt đối không tự mint theo DB.

## Kiểm tra local

```powershell
Set-Location 'C:\Users\nhath\.gemini\antigravity\scratch\minecast-clean'
npm.cmd run build
# Anvil trên PATH hoặc đặt ANVIL_BIN tới executable đã cài.
npm.cmd run v4:app-test

# Tùy chọn: Postgres WASM + trình duyệt, đặt ngoài dependencies production.
npm.cmd install --prefix "$env:TEMP/minecast-v4-ui-tools" --ignore-scripts --no-audit --no-fund @electric-sql/pglite playwright
$env:V4_TEST_TOOLS = "$env:TEMP/minecast-v4-ui-tools"
npm.cmd run v4:storage-test
$env:V4_BROWSER_CHECK = '1'
node --test tests/v4-app-chain.test.mjs
Remove-Item Env:V4_BROWSER_CHECK
```

EVM integration dùng Anvil chain ID 84532 với token/ETH giả, deploy Solidity thật và chạy chính read/action helpers của app. Browser QA dùng Edge headless ở 390/320/1280px, RPC Anvil localhost; không giả receipt hay đổi dữ liệu ví production. Đây chưa phải xác nhận thao tác ví native Farcaster trên iOS/Android hoặc public Base Sepolia.

Kết quả local: kiểm thử API/phase/receipt 14 pass, EVM + browser 9 pass, migration PostgreSQL/PGlite 5 pass, hồi quy cast legacy 16 pass; build legacy và V4, typecheck Edge API. PGlite kiểm tra SQL và phân quyền trên một kết nối, không phải benchmark concurrent Postgres production. Không tăng dependencies chạy app; công cụ browser/SQL được cài ở Temp.
