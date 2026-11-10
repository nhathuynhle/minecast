# MineCast Social Oracle — dịch vụ dữ liệu Farcaster dùng chung

Ngày 2026-11-08. Bản thiết kế để nghiên cứu, chưa phải API/oracle đã triển khai. MineCast mining là một consumer; dự án khác có thể dùng cùng dữ liệu mà không phải đào TOKENCAST hoặc dùng cùng công thức reward. Chưa đổi tokenomics, hợp đồng, API production hoặc cơ chế nâng cấp.

## 1. Khả năng đang có trong repo

`farcaster-source.mjs` là adapter đọc HTTP loopback từ một bản Snapchain được giả định đã đồng bộ, xác minh và đóng băng:

| Hàm | Đang đọc gì | Chưa bảo đảm |
|---|---|---|
| `miningCasts(parentUrl)` | Các cast có parent URL đúng dấu hiệu mining chung | Lịch sử phiên đầy đủ, thời điểm được mạng nhận, bằng chứng nguồn |
| `followersOf(fid)` | FID từ các link follow hướng vào tài khoản | Tổng follower đã chuẩn hóa tại checkpoint, loại tài khoản ảo |
| `hasVerifiedWallet(fid, wallet)` | Có message liên kết ví Ethereum khớp FID/địa chỉ | Người gọi hiện sở hữu khóa ví; bằng chứng trạng thái trên Base |

Adapter kiểm tra network/type/target, phân trang, timeout và cursor lặp. Nó không tự kiểm tra chữ ký Ed25519, chứng chỉ checkpoint, lịch sử validator nguồn hoặc tính đầy đủ của cả tập dữ liệu. Loopback không phải bằng chứng dữ liệu đáng tin nếu host có thể thay server. Bộ test nguồn dùng dữ liệu giả lập.

Có code tạo manifest, digest, reward và relay cho nhánh Nitro thử nghiệm. Chưa có image Nitro production, Open Node registry/verifier/prover, public API tổng quát, indexer lịch sử hoặc mạng operator phục vụ bên thứ ba. `api/mine/start.ts` trong repo vẫn gọi Neynar để kiểm tra cast, follower và ví; không coi đó là consumer của oracle phi tập trung đã hoàn thành.

## 2. Dữ liệu có thể cung cấp khi xây thêm

| Nhóm | Dữ liệu | Ứng dụng |
|---|---|---|
| Identity/profile | FID, username, tên hiển thị, avatar, bio; identity/signer events | Profile, gắn tài khoản, danh bạ |
| Social graph | Ai follow ai, follower/following, mutual follow tại checkpoint | Điều kiện tham gia, referral, phân nhóm cộng đồng |
| Cast | Nội dung, tác giả, hash, parent, mentions, thời gian trong message | Quest, xác nhận bài đăng, phản hồi, dashboard |
| Reaction | Like, recast, FID thực hiện, cast đích | Quest, thống kê tương tác |
| Wallet link | Ví được FID liên kết tại checkpoint | Gắn entitlement theo FID/ví; không thay việc chứng minh quyền ký |
| Derived metrics | Tăng trưởng follower, ngày hoạt động, số người tương tác duy nhất | Analytics, tiêu chí reward, bảng xếp hạng |

Nguồn protocol: [UserData](https://snapchain.farcaster.xyz/reference/httpapi/userdata), [Links](https://snapchain.farcaster.xyz/reference/httpapi/links), [Casts](https://snapchain.farcaster.xyz/reference/httpapi/casts), [Reactions](https://snapchain.farcaster.xyz/reference/httpapi/reactions), [Verifications](https://snapchain.farcaster.xyz/reference/httpapi/verification), [Onchain events](https://snapchain.farcaster.xyz/reference/httpapi/onchain).

Derived metrics phải có công thức/version rõ ràng, không được gắn nhãn “dữ liệu gốc Farcaster”. Follower nhiều không chứng minh người thật hoặc nội dung tốt. Nếu cung cấp Neynar score, phải ghi rõ nguồn Neynar và thời điểm; đó là đánh giá riêng của nhà cung cấp, không phải proof of humanity. [Neynar User Score](https://docs.neynar.com/docs/neynar-user-quality-score).

Read node không tự cho quyền đọc tin nhắn riêng, khóa ví, email/số điện thoại không công khai hay dữ liệu riêng của mọi mini app. Token balance/giao dịch trên Base cần nguồn Base riêng. Số lượt mở app hoặc hành vi bên trong app cần instrumentation do app tham gia cung cấp, không suy ra chỉ từ cast.

## 3. Hai sản phẩm dùng chung nguồn

```text
Farcaster / Snapchain + identity dependencies
                 |
       Read nodes do operator tự chạy
                 |
     Indexer + archive + checkpoint store
          /                         \
 API/stream cho app           Evidence + computation
                                      |
                         Oracle verifier/registry Base
                                      |
                     MineCast / quest / NFT / DAO khác
```

Snapchain cho phép bất kỳ ai chạy read node, lưu trạng thái và phục vụ HTTP/gRPC. Read node khác validator nguồn; chạy node MineCast không tự trở thành validator Farcaster. Nguồn vẫn có các giả định tin cậy của chính Farcaster. [Các loại node](https://snapchain.farcaster.xyz/node-types).

- **Data API:** đọc JSON nhanh để hiển thị/analytics. Client phải biết đang tin endpoint nào. Chỉ trả JSON hoặc ký bằng một operator chưa đạt oracle phi tập trung.
- **Oracle:** cung cấp statement có checkpoint, quy tắc, độ mới và bằng chứng mà consumer contract kiểm tra được. App/relayer mang proof vào giao dịch; contract Base không tự gọi URL HTTP.

Query API có thể luôn phục vụ gần realtime; oracle có feed định kỳ hoặc chứng thực theo yêu cầu. Khoảng 6 giờ/nhịp chốt ngày trong mining không phải giới hạn chung cho mọi query. Không hứa thời gian cập nhật trước khi đo sync, proof và gas.

## 4. Query MVP đề xuất

1. `FOLLOWER_COUNT(fid, checkpoint)`: đếm unique FID còn follow tại checkpoint.
2. `FOLLOWS(sourceFid, targetFid, checkpoint)`: quan hệ follow còn hiệu lực.
3. `CAST_ACTIVE(fid, castHash, checkpoint)`: cast tồn tại trong trạng thái tại checkpoint; khác câu hỏi từng được đăng trong lịch sử.
4. `WALLET_LINKED(fid, address, protocol, checkpoint)`: liên kết ví còn hiệu lực.

Profile và reaction có thể thêm vào API đọc; metrics phức tạp như score chống bot chỉ bổ sung khi đã chốt thuật toán và nguồn lịch sử.

API/schema cần công khai, có version, pagination, SDK và ví dụ cho app khác. Chưa có URL public hoặc endpoint MVP chạy thật. Mỗi consumer tự quyết định ngưỡng follower, checkpoint chấp nhận và reward; oracle không tự áp boost MineCast cho mọi dự án.

## 5. Quy tắc bằng chứng

Tách `sourceStatus` và `computationStatus`: chứng minh tính đúng trên input giả không chứng minh nguồn thật. Mức API observed, operator-attested và source-verified phải phân biệt rõ trong payload/UI. Không tự nâng mức tin cậy chỉ vì có nhiều chữ ký.

Statement tối thiểu ràng buộc network nguồn, tập checkpoint/height/hash liên quan, query type/parameters, FID/địa chỉ/castHash, kết quả, ruleId/version, evidence hash và thời gian quan sát/hết hạn. Consumer kiểm tra max-age, phiên bản, chain ID và địa chỉ verifier; action/claim có request nonce và consumer domain để tránh dùng nhầm hoặc phát lại. Feed đọc công khai có thể tái sử dụng, nhưng quyền trả thưởng phải có khóa chống trả hai lần trong chính consumer.

Để chấp nhận kết quả onchain:

- Xác minh nguồn, lịch sử validator/cấu hình và checkpoint theo một phiên bản protocol cụ thể. Không nhận root tùy ý do operator tự đặt.
- Membership của một cast không chứng minh follower count đầy đủ. Aggregate cần chứng minh bao phủ đủ dữ liệu/shard, chuẩn hóa follow/unfollow, deduplicate và tính đúng. Các trang HTTP phải cùng checkpoint, không trộn trạng thái đang thay đổi.
- Thời gian trong message không đồng nghĩa thời gian được mạng chấp nhận; định nghĩa rõ cutoff theo dữ liệu nào.
- Kết quả phủ định cần bằng chứng không tồn tại hoặc index đầy đủ có thể kiểm chứng. Timeout/thiếu trang/thiếu lịch sử phải trả unavailable, không trả “0 follower” hoặc “không follow”.
- Chứng chỉ hơn 2/3 cọc MineCast chỉ chứng minh sự đồng thuận của snapshot đó; vẫn cần verifier nguồn/tính toán theo mục tiêu Open Node. Nhánh Nitro có giả định phần cứng/chứng thực riêng; không âm thầm đổi sang Nitro khi proof mới chưa xong.
- Công bố evidence/claim data đủ để bên khác tái kiểm tra và phục vụ thay thế. Proof/hash không bảo đảm dữ liệu luôn tải được.

Các verifier/prover này chưa được triển khai; không quảng bá API MVP là trustless hoặc dùng làm nguồn trả tiền không cần tin cậy.

## 6. Lịch sử, vận hành và tính mở

Muốn snapshot “follower hôm qua” phải có archive/checkpoint tương ứng. Một API trạng thái hiện tại không khôi phục được mọi lịch sử. Event retention và pruning của node có thể làm mất dữ liệu cần cho indexer; cần cursor bền vững, phát hiện khoảng trống và backfill từ nguồn có dữ liệu, không tự điền giả. [Retention của Snapchain](https://snapchain.farcaster.xyz/node-types). Có thể tham khảo [đồng bộ Snapchain sang Postgres](https://snapchain.farcaster.xyz/guides/syncing-to-db); chọn phiên bản thực dùng sau khi kiểm tra tương thích.

Tách public read API khỏi cổng admin, khóa ký và đường tạo proof. Cần rate limit, cache theo checkpoint, trạng thái sync/freshness, endpoint discovery và client failover. Nhiều operator độc lập phải tái tạo được cùng kết quả; nhiều tên miền cùng proxy một API Neynar vẫn là một nguồn phụ thuộc.

Giao thức/module dữ liệu nên tách khỏi distributor token. Nâng cấp schema/verifier phải có version và cơ chế phê duyệt công khai được thiết kế trước; consumer ghim version họ chấp nhận. Không sửa nghĩa của một feed cũ hoặc thay verifier bằng khóa dev. Cơ chế upgrade đề xuất chưa có trong code Open Node.

## 7. Kinh tế và lộ trình

Có thể nghiên cứu phí API/proof do dự án sử dụng trả cho operator, tạo nguồn thu dịch vụ ngoài mining. Chưa chọn đồng tiền thu phí, tỷ lệ chia, mức phí, trả theo request hay subscription; không tự mint thêm, đổi cọc 1 triệu, lấy treasury hoặc cấp bonus node cho mọi request. Fee thanh toán không chứng minh dữ liệu đúng; phải chống tạo request giả để ăn thưởng.

Thứ tự thực hiện:

1. Hoàn thiện read node/indexer và archive; chốt semantic bốn query MVP.
2. Public API + SDK, hiển thị rõ mức tin cậy; thử hai operator độc lập từ dữ liệu thật, source bị chậm/mất và client failover.
3. Xây verifier/proof/registry, tích hợp consumer thử nghiệm trên Base Sepolia, đo gas/latency; test stale root, wrong query/version/network, thiếu dữ liệu và replay.
4. MineCast dùng cùng SDK/oracle như dự án khác; sau đó mới chốt phí dịch vụ và triển khai công khai.

Không có phần triển khai network/API/contract mới trong tài liệu này. Mục tiêu là oracle dữ liệu xã hội Farcaster dùng chung, không tuyên bố tương đương bảo mật của Ethereum, Bitcoin hoặc Chainlink.
