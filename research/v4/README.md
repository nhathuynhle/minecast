# MineCast V4 — bản nghiên cứu

**Trạng thái: bản mô phỏng và đề xuất, chưa deploy, chưa audit, không dùng để phát token.** V2 Base Sepolia và V3 không bị thay đổi. Các con số dưới đây là tham số nghiên cứu, chưa được cộng đồng phê duyệt.

## Mục tiêu

Không phụ thuộc một máy chủ hay một người duy nhất để phát reward; ưu tiên creator Farcaster; bất kỳ ai cũng có thể chạy lại phép tính, kiểm tra dữ liệu, vận hành giao diện và gửi kết quả. Điều này không đồng nghĩa hệ thống hoàn toàn trustless: follower, cast, liên kết ví và chất lượng tài khoản vẫn cần dữ liệu Farcaster và một cơ chế giải quyết tranh chấp đáng tin cậy.

## Vòng đời một ngày — đề xuất

1. Contract quy định cố định ngày, pool và trần phát hành. Mỗi FID hợp lệ chỉ nhận một suất mỗi ngày; tài khoản và ví được chốt theo quy tắc công khai tại thời điểm snapshot. Người dùng cần thỏa điều kiện cast và thời gian đào đã chốt trong chính sách.
2. Bất kỳ operator nào có thể tái tạo snapshot và phân bổ bằng mã nguồn mở, công bố dữ liệu và nộp root kèm tiền cọc. Mỗi root phải gắn chain ID, địa chỉ contract, ngày, phiên bản chính sách, snapshot, dữ liệu công bố, tổng pool, tổng phân bổ và định dạng cây Merkle.
3. Có cửa sổ khiếu nại, ví dụ 48 giờ. Trong thời gian này **không thể claim từ root**. Bất kỳ ai có đủ khả năng đặt cọc có thể khiếu nại sai sót hoặc thiếu dữ liệu. Nếu bị khiếu nại thì root bị khóa cho đến khi cơ chế phân xử đã chọn có kết quả; không tự coi hết giờ là đúng.
4. Nếu kết quả hợp lệ, contract chốt root và cho phép claim trong thời hạn đã định. Mỗi leaf ràng buộc ít nhất chain, contract, ngày, FID, ví và amount; contract đánh dấu FID đã claim theo ngày và kiểm soát tổng phát hành. Dữ liệu/proof phải được lưu trên nhiều nguồn công khai và ai cũng có thể tái tạo.
5. Root sai bị loại và cho phép nộp lại, có quy tắc phân chia tiền cọc cho người khiếu nại, bồi hoàn và chi phí phân xử. Nếu không có operator, dữ liệu không thể xác minh, oracle lỗi hoặc tranh chấp chưa giải quyết: ngày đó chờ xử lý; không âm thầm chấp nhận root hoặc chuyển reward của miner sang treasury. Ai cũng được phép thử nộp lại sau khi đủ điều kiện.

Chốt tháng, vote, airdrop, burn và stake là các thành phần onchain riêng. Nếu phụ thuộc hoàn tất dữ liệu mining thì chúng vẫn có thể bị chậm khi oracle kẹt; cần thiết kế đường khôi phục trước khi deploy. Không khẳng định V3 hiện tại tự xử lý được việc này.

## Boost thử nghiệm

Follower **đủ điều kiện** chỉ là tín hiệu, không chứng minh chất lượng nội dung hoặc con người thật. Bảng này là ví dụ bậc thang: dưới 10: x1; 10–499: x2; 500–999: x4; 1.000–1.999: x10; 2.000–4.999: x16; 5.000–9.999: x28; 10.000–24.999: x45; 25.000–49.999: x65; 50.000–99.999: x82; từ 100.000: x100. Cần công bố tiêu chí tài khoản đủ điều kiện, thời điểm chốt, xử lý follow/unfollow và nguồn dữ liệu trước khi triển khai.

Bản mô phỏng `allocation.mjs` dùng integer/bigint, chia pool theo tổng trọng số, làm tròn xuống và áp trần riêng mỗi FID. Phần còn lại được báo riêng, không chia lại trong mô phỏng. **Chưa có chính sách chuyển phần dư được chốt cho V4.** Không cho phép trùng FID hoặc ví trong cùng snapshot của mô phỏng; đây chỉ là kiểm tra dữ liệu đầu vào, không chống được một người tạo nhiều FID/ví.

Ví dụ: pool 10.000, 1.000 follower x10 và 2.000 follower x16, trần mỗi người 10.000 thì lần lượt nhận 3.846 và 6.153; 1 đơn vị còn dư do làm tròn. Pool ít người có thể dẫn tới nhiều dư khi trần thấp. Trần theo FID onchain yêu cầu xác minh liên kết FID–ví và snapshot đáng tin cậy: dữ liệu do người gửi root cung cấp một mình không chứng minh tính xác thực.

## Ranh giới bảo mật và việc chưa quyết định

- Oracle/phân xử: chọn công nghệ, mạng hỗ trợ, token/giá trị cọc, phí, kháng cáo, thời hạn, tình huống thiếu người khiếu nại hoặc thông đồng. Oracle không chứng minh dữ liệu chỉ vì có cọc; kết quả còn phụ thuộc quan sát viên, bằng chứng và quy tắc phân xử.
- Data availability: định dạng snapshot xác định được thứ tự, mã hóa, phiên bản, dữ liệu thô, nguồn, mốc chốt, Merkle proof và bản sao lâu dài. Hash/IPFS CID không bảo đảm dữ liệu tiếp tục có sẵn. Thiếu dữ liệu phải được phép khiếu nại.
- Định nghĩa tính đúng: quy tắc phải bao gồm thiếu người, reward sai, ví sai, dữ liệu giả, tổng leaf so với tổng khai báo và follower thay đổi. Merkle proof thông thường **không** chứng minh toàn bộ danh sách đầy đủ hay tổng leaf đúng; cần phương thức tái tính và phân xử hoặc cấu trúc/chứng minh phù hợp.
- FID và ví: một ví/FID/ngày và thay ví an toàn; xác thực trên Farcaster và chống replay giữa chain/contract/ngày; đối phó ví smart contract. Một FID không đồng nghĩa một con người.
- Chống Sybil: follower bot, vòng follow, thuê follow, giả hoạt động, tấn công nhiều tài khoản, thông đồng operator–challenger và phân xử bị chi phối. Không có cam kết phát hiện hoàn hảo.
- Tham số chưa chốt: lịch phát 21 tỷ/5 năm, pool thực mỗi ngày, trần, boost, thời gian đào/cast, token cọc và nguồn kinh phí vận hành. Mục tiêu 5 năm không tự bảo đảm nếu có ngày không chốt hoặc có pool chưa phát.
- Migration: V2 và V3 là hợp đồng riêng. V4 không tự kế thừa token, balances hay quyền từ V2; cần phương án migration, kiểm tra cung và quyết định cộng đồng trước khi có bất kỳ triển khai nào.
- Kiểm thử: invariant tổng mint không vượt cung/pool, claim một lần theo FID, replay, duplicate, tranh chấp, khiếu nại rỗng, chốt nhầm, dữ liệu không có sẵn, root sai tổng, phục hồi ngày thiếu, làm tròn, stake/vote và liveness. Audit độc lập trước mainnet.

## Chạy thử trên máy

```powershell
node --test research/v4/allocation.test.mjs
node research/v4/example.mjs
```

Không có contract V4 triển khai trong thư mục này: phần oracle, token và quyền trên chain phải được đặc tả, triển khai và kiểm thử riêng sau khi chốt các quyết định trên.
