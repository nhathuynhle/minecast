# MineCast Node V4

Ai cũng có thể chạy cùng một bản phần mềm. Base xác minh bằng chứng thực thi của từng báo cáo. Các app tự chọn endpoint, còn contract khóa một verifier và một phép đo image cho toàn bộ deployment.

## Đường dữ liệu của bản thiết kế

1. Build một image Nitro tái lập được, chứa Snapchain read node hoặc bộ xác minh checkpoint Farcaster, policy của MineCast, bộ đọc API và thuật toán phân bổ. Ghim mạng Farcaster mainnet, checkpoint gốc, luật cập nhật validator, quy tắc nhận cast, thời điểm kết phiên, điều kiện ví/FID và tiêu chí follower trong release. Tất cả file thực thi và cấu hình có ảnh hưởng tới kết quả phải thuộc image được đo hoặc được xác minh trước khi dùng.
2. Bên trong enclave, đồng bộ và xác minh dữ liệu Farcaster. Đóng băng một bản trạng thái cho ngày đang xử lý, ghi height/hash theo shard và mốc thời gian vào manifest. Phải kiểm tra tính liên tục, finality và đủ dữ liệu tới ranh giới chốt, kể cả khi host trì hoãn hoặc gửi lại dữ liệu cũ. Nếu thiếu shard, thiếu lịch sử, mốc chưa chắc chắn hoặc nguồn lỗi thì dừng xuất bằng chứng. Giờ chốt onchain hiện là `dayEnd(day)`. Muốn chốt đúng nửa đêm Việt Nam, phải đặt launchTime đúng mốc 17:00 UTC.
3. Worker đọc API của bản Snapchain đóng băng qua loopback **bên trong cùng enclave**. Host ngoài chỉ được chuyển tiếp byte cho trình đồng bộ đã xác minh. Không mở dịch vụ HTTP giả, file DB do host tạo, biến môi trường đổi nguồn, shell, volume thực thi hoặc proxy tới loopback. Nếu sau này chọn một API HTTPS do bên thứ ba vận hành, danh tính TLS, origin và quy tắc checkpoint phải được khóa trong policy. Khi ấy phải tin cả nhà cung cấp đó.
4. Mọi app dùng chung một parent URL công khai cho mining cast. Worker đọc toàn bộ trang `castsByParent`, kiểm tra FID, ví liên kết, thời điểm cast được mạng xác nhận và điều kiện phiên từ lịch sử. Đọc các link follow hướng vào FID tại cùng checkpoint, xử lý follow/unfollow và trùng FID theo policy. Tự tính cap, nonce và ngữ cảnh Base từ cấu hình đã ghim hoặc trạng thái chain được xác minh. File JSON do operator nhập chỉ phục vụ chạy thử/tái tính công khai. Không đưa đường nhập đó vào entrypoint tạo chứng thực.
5. Dùng `buildWorkManifest` để tính bảng gốc từ toàn bộ miner hợp lệ. Manifest chứa chain, distributor, ngày, pool, FID/ví/follower đã chuẩn hóa, root và tổng phân bổ trước boost node. Trường `evidenceHash` phải băm cùng một bộ bằng chứng nguồn chuẩn hóa gồm policy, cutoff và checkpoint đã xác minh; loại dữ liệu riêng từng máy như giờ tải, đường dẫn cache và ví trả gas. Công bố cả manifest lẫn bằng chứng nguồn. **Không cung cấp API cho host gọi NSM để chứng thực user_data tùy ý.**
6. Worker gọi Nitro Secure Module với 32 bytes digest trong trường `user_data`. Ví ngoài enclave trả gas và cọc ETH. Phần mềm relay có thể thay thế. Contract buộc `msg.sender` khớp ví fee payer đã được ràng buộc trong digest. Node không cấp quyền mint hay giữ khóa rút token của miner.

## Kiểm tra trên Base

**Một ngày, hai bước tính reward.** Việc node phải tự tính bảng là thuộc tính của code đã ghim trong image. Contract xác minh chứng thực của code đó. Release tạo bằng chứng phải đi theo thứ tự:

1. Từng node tính toàn bộ bảng gốc và xác minh FID/ví của chính miner đủ điều kiện. Tạo `nodeWorkDigest` ràng buộc mục đích, chain, contract, policy, ngày, cutoff, hash manifest, FID và ví. NSM chứng thực digest. Ví nhận thưởng gửi packet `kind: "work"` gồm `reporter, day, fid, dataHash, proof` trong 6 giờ sau cutoff; ví trả phí gas, không cần cọc báo cáo. Contract ghi `NodeWorkRecorded`. Mỗi FID, ví và mã instance Nitro được dùng một lần trong cùng ngày/bảng gốc. Một người có thể vận hành nhiều instance/ví khác nhau; giới hạn này không chứng minh danh tính con người hay uptime 24 giờ.
2. Sau khi cửa sổ đóng, worker tái tính bản gốc, đọc `NodeWorkRecorded` theo thứ tự log cho đúng contract/ngày/hash dữ liệu và kiểm tra chuỗi hash biên nhận với `workRosterHash`. Dùng `buildNodeRewardReport` với các biên nhận đó. FID **và** ví phải khớp miner để được ×5, chặn tổng hệ số ở ×100 trước khi chia pool. Commitment của báo cáo cuối ràng buộc hash biên nhận đã dùng; contract tự đọc hash này để kiểm tra. Một bộ log bị bỏ sót làm commitment khác, nên worker dừng. Khi báo cáo bị bác, node có thể nộp lại trong hạn cũ; chỉ biên nhận của manifest khớp bảng được chốt có hiệu lực. Nếu một lỗi buộc phải thay cả manifest sau hạn biên nhận, các biên nhận bảng sai không chuyển sang bảng mới.
3. Mọi miner claim từ cùng một root cuối theo cơ chế hiện có. Việc ghi biên nhận hoặc là người gửi báo cáo chính không tự mint token. Nếu bỏ lỡ 6 giờ ghi biên nhận, miner đủ điều kiện vẫn có suất đào thường.

Ví dụ chạy lại phép tính với Node từ thư mục repo. Đầu vào `daily-input.json` cần thêm `evidenceHash` trỏ tới bộ bằng chứng chung; lệnh đầu tạo file mới chứa chính xác các bytes phải công bố. Lệnh sau đọc log Base Sepolia đã finalized từ block bắt đầu cửa sổ, cần cấu hình `BASE_SEPOLIA_RPC_URL` và `V4_DISTRIBUTOR` khi có deployment.

```powershell
node research/v4/snapshot.mjs --work daily-input.json day-manifest.json
node research/v4/snapshot.mjs --final day-manifest.json <startBlock>
```

`submit` gọi bộ xác minh COSE/P-384 của Base, rồi đối chiếu PCR0 và user_data từ chính các bytes đã được xác thực. Cần cache chuỗi chứng chỉ và tạo inverse hints theo hướng dẫn upstream. Adapter khớp `validateAttestationWithHints` tại [base/nitro-validator 0ea0d12](https://github.com/base/nitro-validator/tree/0ea0d12366b4fa44f9e07e4755f2ad36561cb674). Kiểm định mã triển khai và quản lý revocation trước khi khóa địa chỉ này. [AWS giải thích PCR và debug mode](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html).

- Constructor chặn PCR0 rỗng hoặc debug (48 byte 0). Khi chạy, chứng thực phải đúng image, có timestamp sau khi ngày đóng, tối đa 15 phút tuổi và không đến từ tương lai. 15 phút là tham số thử nghiệm, cần đo thời gian tạo hint và gửi giao dịch trên testnet.
- Commitment báo cáo cuối gồm chain ID, distributor, policy hash, người gửi, ngày, cutoff, nonce của ngày, root, tổng phân bổ, hash manifest, hash URI và hash biên nhận. Chứng thực báo cáo cuối phải được tạo sau khi đóng cửa sổ ghi nhận công việc. Khi một báo cáo được nhận, nonce tăng. Muốn thử lại sau khi báo cáo bị bác thì cần chứng thực mới. Cọc ETH, giới hạn ngày, challenge, vote, claim và trần cung tiếp tục áp dụng.
- PCR0 gắn kết quả với một bản chương trình cụ thể. Độ chính xác của follower vẫn phụ thuộc code nguồn, checkpoint và dữ liệu được xác thực bởi chương trình. Ghim hash của một image có cửa sau, hoặc đọc API do host giả lập, sẽ làm hỏng cả thiết kế. Nitro cũng tạo phụ thuộc vào hạ tầng, root chứng thực và cơ chế thu hồi của AWS. Một người có thể chạy nhiều instance; số instance không tạo thêm quyền biểu quyết.
- Nếu image, nguồn, verifier hoặc network policy cần đổi, deployment thử nghiệm này đòi hỏi migration. Cần có chiến lược phục hồi nếu AWS/verifier dừng hoạt động trước khi dùng mainnet.

## Hiện trạng

Đã có adapter API cho cast/follow/ví, code tính snapshot/digest, relay và cổng bắt buộc chứng thực trong distributor. Bộ test EVM chạy toàn bộ đường nộp tới claim, với verifier test thay thế riêng bước xác minh chữ ký Nitro. Chưa có image Nitro hoàn chỉnh, bộ xác minh và lưu lịch sử theo shard, policy phiên hoàn chỉnh, adapter NSM hay phép đo PCR0 thật. Cần bổ sung các phần này và thử hai máy độc lập tạo cùng snapshot từ dữ liệu thật trước khi deploy. Chứng thực của một node không bảo đảm tập tin vẫn tải được suốt cửa sổ khiếu nại/claim.

Relay nhận packet có các trường `reporter, day, root, allocated, dataHash, dataURI, proof`. Dùng chuỗi số thập phân cho day/allocated. Proof gồm `tbs, signature, hints` dạng hex. Adapter nhận TBS/signature theo `decodeAttestationTbs` của NitroValidator. Sau khi có deployment testnet và packet thật, có thể mô phỏng:

```powershell
$env:V4_DISTRIBUTOR = '<địa chỉ distributor V4 trên Base Sepolia>'
node research/v4/node/relay-report.mjs packet.json
```

Muốn gửi thật, relayer dùng ví test riêng trùng `reporter`, cấu hình `NODE_RELAYER_KEY` cục bộ và thêm `--send`. Khóa này nằm ngoài worker, không được ghi vào repo hoặc manifest.
