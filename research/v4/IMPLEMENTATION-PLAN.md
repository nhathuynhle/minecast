# Chạy thử MineCast V4

**Tài liệu lịch sử của Nitro.** Bản Open V4 Quorum đã có contract và công cụ local từ 2026-11-09; dùng [hướng dẫn hiện tại](./OPEN-V4-READINESS.md). Các mô tả “registry chưa có/ngưỡng chưa chốt” bên dưới là trạng thái trước quyết định mới.

Lưu ý phiên bản: hướng dẫn này dành cho contract V4 Nitro zero-premine hiện có. Open Node hiện chọn [premine 2,1 triệu vào ví dev và mining 99,99%](./node/DEV-BOOTSTRAP.md), thay thế phương án 1% thanh khoản ban đầu. Đã có `TokenCastOpenV4` và [helper thêm thanh khoản sau, khóa LP vĩnh viễn](./LIQUIDITY-IMPLEMENTATION.md), chưa tích hợp vào quy trình Nitro bên dưới. Validator nạp token tự sở hữu, tối thiểu 1 triệu; registry/verifier Open Node chưa hoàn chỉnh. Mining không bắt buộc có pool; chưa chốt vốn ETH/cấu hình DEX Base hoặc tạo pool thật.

Bộ test triển khai cả hệ thống lên Anvil cục bộ và mô phỏng giao dịch của nhiều ví cùng việc chuyển ngày/tháng. Chạy từ thư mục gốc repository với Node, các dependencies trong package-lock và Anvil 1.7.1 trên PATH (hoặc trỏ `ANVIL_BIN` tới executable). Test tự mở cổng ngẫu nhiên trên 127.0.0.1 rồi đóng, dùng chain 31337 với tài khoản giả.

```powershell
Set-Location 'C:\Users\nhath\.gemini\antigravity\scratch\minecast-clean'
npm.cmd ci
node --test research/v4/emission.test.mjs research/v4/allocation.test.mjs research/v4/node/source.test.mjs research/v4/protocol.test.mjs
```

Bộ test lịch phát hành đối chiếu số nguyên với phân số chính xác `199^day / 200^day`, cộng ngân sách 20.000 ngày và so kết quả node với contract. Test EVM kiểm tra biên ngày, trần claim 1%, vượt trần 1 wei, burn không mở lại hạn mức, ngày bị bỏ lỡ không cộng bù, cùng các luồng oracle/staking/DAO hiện có. `TestEmissionDistributor` và `TestNitroValidator` trong `fixtures` chỉ phục vụ test, tuyệt đối không dùng làm distributor/verifier thật.

Xem bảng ngân sách (ngày giao diện bắt đầu từ 1; API contract bắt đầu từ 0):

```powershell
node research/v4/emission.mjs 1 2 30 60 365 730 919
```

## Thứ tự nối contract trong bản thử nghiệm

1. Deploy `TokenCastV4(bootstrapAdmin, launchTime)`. Chọn Unix timestamp tương lai đủ xa để hoàn tất cả staking và các bước nối. Chưa tạo token lúc khởi tạo.
2. Deploy `MineCastStakingV4(token)`. Contract kế thừa staking V3 và lấy mốc epoch từ token mới.
3. Deploy `MineCastMonthlyDaoV4(token, staking)`. Địa chỉ này chính là treasury cộng đồng.
4. Sau khi hoàn tất image và xác minh verifier trên mạng đích, deploy `MineCastDailyDistributorV4(token, staking, dao, ethBondWei, policyHash, nitroValidator, pcr0)`. Dùng 48 bytes PCR0 của build production. Đối chiếu bytecode, AWS root, quyền thu hồi chứng chỉ và các dependency của verifier với bản đã đánh giá. Verifier giả lập chỉ đặt trong thư mục test. Xem [thiết kế node](./node/DESIGN.md).
5. Đọc lại toàn bộ địa chỉ, bytecode, policy, launch time và bond. Kiểm tra `DAILY_DECAY_BPS = 50`, ngân sách ngày 0 là 105 triệu token và `MAX_MINER_BPS = 100`. Node/image phải dùng lịch giảm 0,5% mỗi ngày này, không dùng lại lịch halving trước đó. Bootstrap admin gọi `finalizeDistributor(distributor)` đúng một lần. Chọn sai triển khai có thể làm hỏng vĩnh viễn đường phát token.
6. Công bố chain ID và địa chỉ bộ contract cho các app. Ai cũng có thể chạy image đã ghim và nộp báo cáo kèm chứng thực và cọc. Mọi ví đều có thể khiếu nại trong hạn nếu đặt đủ cọc.

## Trước khi thử với người dùng

- Bổ sung worker/indexer Farcaster, chốt quy tắc nguồn follower, xác minh cast/FID/ví tại snapshot, công bố input và lưu nhiều bản để cộng đồng tự tạo proof. Ngay cả khi có worker, vẫn cần người theo dõi root sai và người gọi giao dịch chốt đúng hạn.
- Nối UI V4 tới ABI/địa chỉ mới cho submit/challenge, claim mining, stake/activate, vote, claim reward, chốt tháng, airdrop và chọn nguồn node. Tài khoản, token, vote và lịch sử V2/V3 không tự di chuyển.
- Kiểm thử công khai trên Base Sepolia. Cần đánh giá khả năng chặn lúc bootstrap, cọc so với giá trị pool, thông đồng giữa staker và operator, nguồn dữ liệu biến mất, gas khi có rất nhiều ví, fuzz các bất biến cung và audit độc lập trước mainnet.
