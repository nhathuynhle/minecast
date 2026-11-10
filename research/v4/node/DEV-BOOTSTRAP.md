# Khởi động Open Node bằng premine dev 2,1 triệu

Quyết định ngày 2026-11-08 thay thế cả quỹ cho mượn cọc lẫn 1% thanh khoản ban đầu. Cập nhật 2026-11-09: bộ contract [Open V4 Quorum](../OPEN-V4-READINESS.md) đã có bản local với registry, distributor, staking và DAO. Chưa có mạng node vận hành; mini app/testnet đang chạy chưa chuyển phiên bản.

## Ngân sách

| Hạng mục | TOKENCAST |
|---|---:|
| Tổng mint trọn đời tối đa | 21.000.000.000 |
| Premine vào ví dev, đúng một lần | 2.100.000 (0,01%) |
| Ngân sách mining | 20.997.900.000 (99,99%) |
| Pool mining ngày đầu | 104.989.500 |
| Pool mining ngày thứ hai | 104.464.552,5 |
| Pool mining ngày thứ ba | 103.942.229,7375 |
| Trần mỗi miner ngày đầu, 1% pool | 1.049.895 |
| Cọc tối thiểu mỗi validator, đề xuất đã chốt | 1.000.000 |

Ngày `d = 0` là ngày mining đầu. `pool(d) = 104.989.500 × 0,995^d`. Ngày đầu có 0,5% ngân sách mining (0,49995% tổng cung); ngày sau giảm 0,5%. Trần mining sau n ngày lý thuyết là `20.997.900.000 × (1 - 0,995^n)`. Cộng premine không vượt 21 tỷ. Contract/mô hình dùng số nguyên, giới hạn riêng từng ngày; thực mint còn tùy báo cáo, claim và làm tròn.

Premine được tính vào `cumulativeMinted` kể cả khi chuyển, cọc, cấp pool hoặc burn. Burn không hoàn hạn mức. Không còn mint thêm 210 triệu thanh khoản. Distributor Open V4 thực thi cap 1%/FID/ví, công thức follower boost, node ×5 tối đa tổng ×100, phần chưa phân bổ 5% staking/95% DAO và claim 24 giờ; tính đúng của follower/nodeWork vẫn do quorum chứng nhận.

## Dev và node đầu tiên

Constructor token nhận ví dev rõ ràng; không tự dùng lại ví deploy, signer hoặc treasury testnet cũ. Ngay khi deploy, 2,1 triệu là số dư có thể chuyển nhượng của dev, không phải cọc đã khóa. Dev approve và nạp ít nhất 1 triệu vào registry sau khi bộ contract được triển khai; nếu nạp đúng 1 triệu thì còn 1,1 triệu trong ví, chưa trừ bất kỳ chuyển khoản nào khác. Không cần mua token từ DEX để có cọc ban đầu. Vẫn cần ETH cho gas và chi phí máy vận hành.

Founder phải nạp escrow và chờ activation như mọi operator. Trọng số ký dựa trên token thực cọc tại snapshot; không có khóa founder riêng để vượt quorum. Cọc node và stake DAO là hai escrow riêng; không tính cùng token hai lần. Token mua/đào/nhận chuyển khoản đều có thể dùng cọc nếu đúng điều kiện.

`MIN_TOTAL_BOND` toàn mạng đã chốt **1 triệu TOKENCAST**, bằng tối thiểu mỗi validator. Một validator cọc đủ có thể khởi động. Registry khóa gia nhập 7 ngày, activation có hiệu lực ở ranh giới ngày kế tiếp (ngày 0 nếu trước launch), rút sau 30 ngày từ ranh giới exit. Chuẩn bị trước `launchTime`; thiếu quorum thì không chốt ngày, không tự lùi lịch hoặc bù pool.

**Chỉ một operator active là 100% trọng số active**, kể cả chia thành nhiều địa chỉ. Premine giúp khởi động, không tự tạo tính phi tập trung hay chi phí tấn công bằng USD. Công thức thưởng được kiểm tra onchain; hơn 2/3 chữ ký không chứng minh follower đúng, người dùng đã chấp nhận giả định tin cậy này. Không hứa tắt node đầu tiên mà mạng tiếp tục nếu các node khác chưa đủ trọng số.

## Thanh khoản sau mining

Không bắt buộc tạo pool để deploy token hoặc phát mining hợp lệ. Dev có thể chọn token đang sở hữu, gồm premine chưa cọc và token đã claim, ghép ETH trên Base sau này. Token còn trong escrow không đồng thời dùng cấp pool; phải rút đúng điều kiện trước. Chưa chốt lượng TOKENCAST/ETH, factory/WETH Base hoặc thời điểm.

Helper [MineCastLiquidityLockerV4](../../../contracts/v4/liquidity/MineCastLiquidityLockerV4.sol) lấy token từ chính caller, wrap ETH cần dùng, khóa LP mới vào locker vĩnh viễn. Hoạt động với pool trống lẫn pool đã có giao dịch; hoàn ETH dư và chỉ kéo số token cần dùng. Không có khoản mint riêng cho thanh khoản. Toàn bộ LP tạo qua helper không rút được hoặc thu phí riêng; LP thêm bằng đường khác không tự có bảo đảm này.

Dev có thể không thêm thanh khoản: **đây là kế hoạch tự nguyện, không phải nghĩa vụ được token cưỡng chế**. Premine phải công khai. Không mô tả token là zero-premine hoặc mọi quyền đã phi tập trung.

## Trạng thái triển khai

Đã viết/test local: premine một lần, trần ngày/lifetime, không refill khi burn, phát hành trước pool, dùng token có sẵn thêm LP và khóa vĩnh viễn. [Chi tiết ABI và kiểm thử](../LIQUIDITY-IMPLEMENTATION.md).

Đã có/test local: registry cọc/checkpoint/slash, certificate EIP-712, công thức reward onchain, bắt buộc công bố bảng claim và distributor Open V4. Còn worker thu thập dữ liệu, vận hành node độc lập, testnet, tích hợp app và audit. V4 Nitro cũ (`TokenCastV4.sol`, `emission.mjs`, `snapshot.mjs`) giữ lịch zero-premine 105 triệu; không thay token address để trộn hai bản.

```powershell
Set-Location 'C:\Users\nhath\.gemini\antigravity\scratch\minecast-clean'
node research/v4/node/bootstrap-model.mjs
node --test research/v4/node/bootstrap-model.test.mjs research/v4/node/quorum-model.test.mjs
```

CLI in premine, mining và trần số học, `initialLiquidityRequired: false`; `initialEthAmount: null` nghĩa chưa chọn lượng ETH. Không báo giá token, không tạo pool hoặc gửi giao dịch.
