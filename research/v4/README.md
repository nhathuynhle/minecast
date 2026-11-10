# MineCast V4

**Bản đang chuẩn bị mainnet: [Open V4 Quorum — đặc tả, kiểm thử và triển khai](./OPEN-V4-READINESS.md)**, cập nhật 2026-11-09. Người dùng đã chọn hơn 2/3 tổng cọc node ký, tổng cọc tối thiểu 1 triệu TOKENCAST, cho phép một node bootstrap. Chấp nhận quorum thông đồng có thể khai sai dữ liệu xã hội; bản này không yêu cầu Nitro/ZK/source proof.

Đã có bộ Solidity riêng trong `contracts/v4/open`: token, registry cọc, oracle/distributor theo quorum, công thức thưởng và staking; dùng DAO tháng trong `contracts/v4/MineCastMonthlyDaoV4.sol`. Có builder báo cáo EIP-712/Merkle, xuất ABI/bytecode, kế hoạch deploy chưa ký và trình kiểm tra bytecode/binding. **Tích hợp miniapp/API V4 local đã có**; xem [cấu hình, migration và kiểm thử](./MINIAPP-INTEGRATION.md). Mini app, API và token Base Sepolia đang phục vụ người dùng vẫn chạy luồng cũ cho tới khi bật cấu hình V4. Chưa deploy Open V4, chưa có audit độc lập hoặc mạng node vận hành.

Open V4 giữ premine 2,1 triệu vào ví dev; mining 20.997.900.000 token, ngày đầu 104.989.500, giảm 0,5%/ngày. Cọc node và tổng cọc mạng đều tối thiểu 1 triệu. Công thức boost, trần 1%, phân bổ dư 5/95 và hạn claim mining 24 giờ được contract thực thi. Mọi allocation phải công bố onchain trước claim. [Thanh khoản khóa LP](./LIQUIDITY-IMPLEMENTATION.md) vẫn là mô-đun tùy chọn riêng.

**Phần dưới là tài liệu lịch sử của V4 Nitro, không phải hướng dẫn triển khai Open V4.** Giữ mã/test cũ để nghiên cứu và hồi quy; không dùng `snapshot.mjs`, `emission.mjs` hoặc ABI Nitro thay cho Open V4.

## Lịch phát hành bản Nitro hiện có (trước premine dev Open Node)

- Tổng mint trọn đời tối đa **21 tỷ TOKENCAST**, burn không mở lại hạn mức.
- Ngày đào đầu tiên có ngân sách **105 triệu TOKENCAST** (0,5% tổng cung). Mỗi ngày sau giữ **99,5%** ngân sách ngày trước, tức giảm **0,5%/ngày**. Không áp dụng thêm halving 272 ngày.
- Công thức lý thuyết: `pool(day) = 105.000.000 × 0,995^day`, với `day = 0` là ngày đầu trong contract. Ngày thứ hai là 104.475.000, ngày thứ ba là 103.952.625 token. Ngày đào dài 24 giờ tính từ `launchTime`, không tính lại khi một ví mở app hoặc claim.
- Ngân sách lũy kế lý thuyết sau `n` ngày là `21 tỷ × (1 - 0,995^n)`: khoảng 25,97% sau 60 ngày, 83,95% sau 365 ngày và 99% sau 919 ngày. Sau 919 ngày vẫn tiếp tục giảm, không có mốc dừng cưỡng bức ở đây hay sau 5 năm.
- Trần mỗi FID/ví vẫn **1% pool của ngày đào được claim**: tối đa 1.050.000 token ở ngày đầu. Boost follower và bonus node chia cùng pool, không tạo thêm nguồn phát hành. Đó là trần, không phải phần thưởng đảm bảo.
- Contract dùng độ chính xác `1e36` và phép nhân số nguyên làm tròn xuống để tính pool. Chỉ ngày đào đã kết thúc mới mở ngân sách. Ngày bị bỏ lỡ không cộng bù vào ngày sau; phần bụi làm tròn không được mint. Khi pool nhỏ hơn 1 wei token, ngân sách ngày đó bằng 0. `releasedSupplyAfterDays` là trần lịch phát hành; mọi lần mint còn phải qua trần riêng từng ngày và bộ đếm mint trọn đời.

`emission.mjs` tính cùng kết quả số nguyên với contract. Lệnh sau in ngân sách và trần miner cho các ngày được đánh số từ 1:

```powershell
node research/v4/emission.mjs 1 2 30 60 365 730 919
```

Các số này là ngân sách, không phải lượng token chắc chắn đã mint hoặc đang lưu hành. Phần chưa phân bổ, phần đã phân bổ nhưng chưa claim và quyền nhận thưởng vẫn xử lý theo luồng bên dưới.

## Từ cast đến token

1. Người vận hành thu thập cast, FID, ví và follower hợp lệ của ngày đào. Họ công bố dữ liệu thô và quy tắc tính điểm để người khác có thể chạy lại. Phần thu thập và chuẩn hóa dữ liệu lịch sử Farcaster vẫn cần thực hiện ngoài chain.
2. Ai cũng có thể vận hành bản node đã ghim. Sau khi ngày đào kết thúc, ví gửi phải có chứng thực Nitro của đúng bản node cho chính báo cáo đó, cùng cọc ETH. Ngày đào dài 24 giờ tính từ `launchTime`. Contract khóa hash policy, phiên bản node, verifier, tổng theo ngày và trần 1% pool mỗi FID/ví. Mỗi lượt claim cần proof cho chính ví gửi, FID, ngày, chain và distributor đó.
3. Ai cũng có thể đặt cọc bằng bên nộp để khiếu nại trong 48 giờ, kể cả khi dữ liệu không tải được. Khi có tranh chấp, staker đã stake đủ 30 ngày và đã kích hoạt quyền trước snapshot có 48 giờ kể từ lúc khiếu nại để vote. Có thể bỏ phiếu chấp nhận hoặc bác. Mỗi ví bỏ một phiếu có trọng số. Bên thắng nhận hai cọc qua `withdrawBond`. Hòa gồm cả 0–0 thì bác báo cáo và hoàn cọc hai bên. Nếu chưa bị phản đối sau 48 giờ, bất kỳ ví nào cũng có thể chốt.
4. `activateDay` phân xử và mở claim trong cùng giao dịch. Miner có đúng 24 giờ từ giao dịch này. Toàn bộ phần đã phân bổ được giữ riêng. Khi hết hạn, phần đã phân bổ mà miner bỏ lỡ sẽ vĩnh viễn chưa mint. Phần *chưa phân bổ* mới được chia 5% vào staking epoch tiếp theo và số còn lại vào DAO. Một báo cáo rỗng hợp lệ chia toàn bộ pool theo cách này. Ngày thiếu báo cáo hoặc bị loại hoàn toàn sẽ bỏ phát hành.
5. Báo cáo mới cần nộp trước khi hết ngày thứ tư kể từ khi ngày đào kết thúc để đủ thời gian khiếu nại và vote. Có thể nộp lại root đã bị loại nếu còn trong hạn. Từ mốc 8 ngày sau khi ngày đào kết thúc, bất kỳ ai cũng có thể dọn báo cáo để giải phóng cọc theo kết quả vote. Quá mốc đó sẽ không mở claim hoặc phát phần dư, kể cả report đã qua thời gian phản đối.

Hàm phân bổ trong `allocation.mjs` dùng số nguyên, chia theo trọng số follower, chặn theo trần rồi giữ phần dư. Bảng boost nghiên cứu lần lượt là ×1 dưới 10, ×2 từ 10, ×4 từ 500, ×6 từ 1k, ×10 từ 2k, ×18 từ 5k, ×30 từ 10k, ×50 từ 25k, ×75 từ 50k và ×100 từ 100k follower hợp lệ. Khi ít miner cùng chạm trần, reward có thể bằng nhau.

## Phần thưởng cho miner chạy node

**Boost người chạy node.** Miner có phiên hợp lệ và có biên nhận Nitro cho bảng gốc đúng của chính ngày đó được tính trọng số `min(100, followerWeight × 5)`. Miner thường dùng `followerWeight`. Ví dụ 1k follower từ ×6 lên ×30, 2k từ ×10 lên ×50, 5k từ ×18 lên ×90 và từ 10k đạt ×100. Mọi ví vẫn chịu trần 1% pool ngày và chia theo tổng trọng số. Nếu ít miner cùng chạm trần, số token nhận được có thể bằng nhau. Người không có phiên đào hợp lệ không nhận khoản boost này.

Trong 6 giờ đầu sau khi ngày đào kết thúc, mọi node có thể gọi `recordNodeWork`, kể cả khi một node khác sẽ nộp báo cáo chính. Báo cáo cuối chỉ mở sau 6 giờ này. Xem [cách lập bảng gốc và kiểm tra biên nhận](./node/DESIGN.md). Khoảng 6 giờ là tham số thử nghiệm.

## Stake, chốt tháng và vote

- Stake dùng lại logic V3. Mỗi lần nạp thêm khóa lại toàn bộ vị thế 30 ngày. Sau khi đủ hạn, gọi `activateGovernancePower()` trước snapshot để vote. Cả DAO và oracle lấy quyền của block ngay trước lúc mở biểu quyết. Token rút hoặc chuyển sau snapshot không sinh thêm quyền trong cùng cuộc bỏ phiếu.
- 5% phần dư tài trợ `currentEpoch() + 1`. Epoch dài 30 ngày. Bất kỳ ai cũng có thể gọi `snapshotEpoch` trong ngày đầu, `finalizeEpoch` sau khi epoch kết thúc, rồi từng staker `claim` theo số lượng đã stake ở snapshot. Epoch lỡ snapshot dùng `skipEpoch` theo thứ tự để chuyển funding sang epoch kế. Sau 90 ngày, `sweepUnclaimed` cuốn số dư vào đợt finalize tiếp theo, kể cả epoch có tổng stake bằng 0. Tiền gốc rút riêng bằng `withdraw`.
- Mining được tính vào tháng UTC của lúc **bắt đầu ngày đào**. Bất kỳ ai cũng có thể gọi `finalizeMonth` với Unix timestamp 00:00 UTC ngày đầu tháng sau, khi đã qua thêm 10 ngày. Mốc bảo thủ này cho phép cả ngày đào cuối tháng, khiếu nại và 24 giờ claim kết thúc. Ngày thiếu, ngày bỏ lỡ và tháng không có claim không chặn việc chốt. Sau đó cả tử số từng ví và mẫu số tổng claim đều cố định.
- Giữ khung mở vote ngày 8–21 UTC giống V3. Vì cần chốt tháng trước nên với V4 thời điểm mở sớm nhất thực tế là ngày 11. Gọi `openMonthlyVote` một lần mỗi tháng. Vote Yes/No trong 7 ngày, Yes lớn hơn No thì thực thi sau thêm 72 giờ. Hòa hoặc không có phiếu thì gọi `settle` để giải phóng ngân sách. Ai cũng có thể gọi. Nếu bỏ lỡ khung mở, tháng đó không có vote.
- Tháng lẻ dành tối đa **10% lượng miner đã claim tháng trước** để airdrop theo đúng tỷ lệ claim của từng ví. Tháng chẵn dành tối đa **5% của cùng cơ sở tính** để burn. Cả hai giới hạn theo số token kho bạc còn tự do khi mở vote. Treasury giữ riêng ngân sách từng round. Airdrop theo vote có cửa sổ 90 ngày như V3, phần hết hạn dùng `releaseExpiredAirdrop` trả về ngân sách tự do. Cửa sổ claim mining hằng ngày là 24 giờ.

## Dữ liệu công khai và giới hạn

Input JSON cho `snapshot.mjs` gồm `chainId`, `distributor`, `day`, `poolWei` dạng chuỗi thập phân và `miners` gồm các dòng `{fid, wallet, followers}`. Lấy `poolWei` bằng `dailyEmissionForDay(day)`; công cụ kiểm tra đúng lịch giảm 0,5% và từ chối pool của ngày khác hoặc lịch halving cũ. Công cụ trả hash của chính bytes tập tin, root, allocated và proof cho từng ví. Public URI cần trỏ tới đúng bytes, công bố kèm dữ liệu nguồn đủ để tái hiện số follower/cast tại thời điểm chốt. Ví dụ lệnh chạy:

```powershell
node research/v4/snapshot.mjs daily-input.json
```

Merkle proof xác nhận leaf nằm trong root. Nó không tự phát hiện thiếu FID, hai người cùng ví, sai follower, thiếu dữ liệu hoặc tổng leaf vượt số đã khai. Khi không có người kiểm tra trong 48 giờ, kết quả sai vẫn có thể chốt. Staker lớn có thể chi phối tranh chấp hoặc vote DAO nếu ít người tham gia. Giai đoạn đầu chưa có stake trưởng thành, một người liên tục khiếu nại có thể chặn root và nhận lại cọc khi hòa. Chưa có kháng cáo cấp hai. Cần lựa chọn mức cọc thực tế, chính sách Farcaster có thể tái lập, cơ chế duy trì bản sao dữ liệu và đánh giá rủi ro bootstrap trước khi dùng tài sản thật.

## Node và app cộng đồng

Mỗi builder được chọn hoặc tự vận hành node. Oracle chỉ nhận báo cáo có bằng chứng gắn với bản chương trình đã ghim. Khiếu nại, chốt ngày và claim vẫn mở theo các thời hạn đã định. Xem [thiết kế node, mã đã có và điều kiện thử thật](./node/DESIGN.md).

Token khóa tổng mint trọn đời 21 tỷ và lịch giảm 0,5% mỗi ngày từ mức 105 triệu token/ngày. Số thực phát còn phụ thuộc báo cáo và claim. Xem [chạy thử, thứ tự nối contract](./IMPLEMENTATION-PLAN.md).
