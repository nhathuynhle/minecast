# MineCast Open Node — đề xuất để thảo luận

**Lưu trữ thiết kế ngày 2026-11-08.** Quyết định 2026-11-09 thay yêu cầu source/validity proof bắt buộc bằng chữ ký >2/3 tổng cọc; `MIN_TOTAL_BOND = 1 triệu`, chấp nhận một node bootstrap và rủi ro quorum khai sai dữ liệu. Đã có bộ contract, kiểm thử và công cụ local tại [Open V4 Quorum](../OPEN-V4-READINESS.md). Nội dung dưới đây mô tả đề xuất ban đầu, không phải đặc tả triển khai mới.

Ngày: 2026-11-08 (Asia/Saigon). **Đây là phương án nghiên cứu riêng; chưa thay thế V4 Nitro, chưa có mạng node hoặc deployment công khai theo phương án này.** Phần xác nhận node mới có mô hình số học, không dùng mô hình đó để duyệt mint. Phần token/thanh khoản có prototype Solidity local riêng được mô tả bên dưới.

Cập nhật đã được người dùng chọn: theo hướng ETH + BTC, **premine 2,1 triệu TOKENCAST (0,01%) vào ví dev** để có token nạp cọc node đầu tiên. Thay thế cả phương án 210 triệu thanh khoản ban đầu lẫn quỹ cho mượn cọc. Operator nạp token tự sở hữu, tối thiểu 1 triệu. Chi tiết tại [bootstrap bằng premine dev](./DEV-BOOTSTRAP.md). Có [token và helper thêm thanh khoản sau, khóa LP vĩnh viễn, thử nghiệm local](../LIQUIDITY-IMPLEMENTATION.md); mining không yêu cầu có pool. Chưa chốt vốn ETH/cấu hình DEX Base, chưa tạo pool thật. Không áp dụng phương án node cuối cùng tự thay luật. Contract V4 Nitro và `emission.mjs` cũ vẫn zero-premine, 105 triệu/ngày đầu; chưa tương thích với ngân sách mới.

## Mục tiêu và nguyên tắc

Ai cũng có thể chạy node, xây mini app hoặc gửi báo cáo mà không xin phép founder. Node tự đồng bộ dữ liệu Farcaster, tự kiểm tra và tính lại reward. Token, claim, tiền cọc và kết quả cuối cùng vẫn nằm trên Base; không tạo blockchain mới hay giả định có mức an toàn tương đương Bitcoin/Ethereum.

- Học Bitcoin: luật công khai, mỗi node tự kiểm chứng, nhiều client có thể cùng thực hiện một đặc tả. Không đếm số máy để chọn sự thật và không thêm đào PoW vào TOKENCAST.
- Học Ethereum: tiền cọc tạo trọng số, bộ người xác nhận được chụp trước kỳ, chữ ký mâu thuẫn có thể bị phạt, rút cọc phải chờ. Đây không phải bản sao Gasper/Casper. MineCast cọc TOKENCAST trên Base; không được hưởng bảo mật của validator Ethereum cho dữ liệu mining chỉ vì học nguyên tắc PoS.
- Mục tiêu cuối: **chứng chỉ đủ chữ ký + bằng chứng dữ liệu/phép tính hợp lệ + dữ liệu claim đã công bố** mới mở claim. Quorum riêng lẻ không chứng minh follower đúng.
- Base đảm nhiệm thứ tự giao dịch và settlement. Không có leader MineCast duy nhất. Người tổng hợp chữ ký có thể thay thế; mọi người đều có thể gửi các phần chữ ký lên Base.

## Tokenomics sau premine dev 0,01%

| Quy tắc | Giá trị |
|---|---|
| Mint trọn đời | Tối đa 21 tỷ; burn không làm tăng lại hạn mức |
| Premine dev | 2.100.000 TOKENCAST (0,01%), mint một lần vào ví dev, có thể chuyển nhượng |
| Thanh khoản | Tùy chọn thêm sau từ token đã sở hữu + ETH Base; helper khóa LP mới vĩnh viễn |
| Cọc tối thiểu mỗi validator | 1.000.000 TOKENCAST tự sở hữu nạp vào escrow; ngưỡng tổng cọc mạng chưa chốt |
| Ngân sách mining còn lại | 20.997.900.000 TOKENCAST (99,99%) |
| Pool ngày d | `104.989.500 × 0,995^d`, mô hình riêng `bootstrap-model.mjs` |
| Trần miner | 1% pool/ngày/FID và ví |
| Trọng số follower | Giữ bảng trong `allocation.mjs` |
| Bonus node | Công thức ×5, tổng hệ số tối đa ×100; không có pool mint thêm |
| Phần chưa phân bổ | 5% staking, 95% DAO |
| Đã phân bổ nhưng chưa claim | Không tính vào phần dư; hết hạn thì không mint |
| Claim mining | 24 giờ kể từ khi ngày được kích hoạt |
| DAO | Stake TOKENCAST đủ 30 ngày; tháng lẻ air, tháng chẵn burn, Yes/No như hiện tại |

Tiền cọc node bên dưới là quyền xác nhận kỹ thuật, không phải quyền DAO. Hệ số follower không tăng quyền xác nhận. Quy tắc nhận bonus ×5 cần một loại bằng chứng mới nếu bỏ Nitro; đây là thay đổi điều kiện thực thi cần đánh giá, không phải tính năng đã có.

Giữ hệ số phát hành 0,5% ngân sách mining ở ngày đầu và giảm 0,5%/ngày. Premine đã nằm trong 21 tỷ, không có khoản mint 210 triệu thanh khoản nữa. Trần miner ngày đầu là 1.049.895 token. Dev nhận token có thể chuyển nhượng; contract không bắt buộc phải cọc hoặc tạo pool sau. Chỉ LP tạo qua helper mới khóa tự động. Chưa có deployment hoặc giao dịch khóa trên mạng công khai.

## 1. Ba vai trò mở

1. **Read node/watchtower:** bất kỳ ai đồng bộ, tính lại và kiểm tra, không cần stake; có thể phục vụ API/proof cho app. Máy thường/VPS phù hợp tài nguyên có thể chạy, không bắt buộc Nitro hay một nhà cung cấp cloud. Tài nguyên thực tế chưa benchmark.
2. **Validator MineCast:** có vị thế cọc TOKENCAST tự sở hữu hợp lệ và khóa ký riêng để xác nhận bảng thưởng. Operator có thể mua token từ pool hoặc dùng token đã đào rồi nạp cọc; không vay token từ quỹ hoặc khóa ETH làm bảo đảm. Bất kỳ ai đủ điều kiện công khai đều đăng ký được. Validator MineCast không trở thành validator Snapchain hay Ethereum.
3. **Prover/relayer:** tạo bằng chứng tính toán hoặc chuyển tiếp chữ ký/bằng chứng. Không sở hữu đặc quyền mint, không giữ khóa rút của miner. Ai cũng có thể thay thế.

Nguồn dữ liệu là Snapchain read node tự đồng bộ và kiểm tra chứng chỉ commit, trạng thái và cấu hình validator nguồn. API chỉ là giao diện đọc dữ liệu đã kiểm tra. Lấy `follower_count` từ một API thương mại duy nhất không đạt mục tiêu này.

## 2. Cọc, gia nhập và rút

Dev được premine 2,1 triệu để có nguồn token nạp cọc; token không tự chuyển vào registry. Operator khác có thể dùng token đã đào, mua hoặc được chuyển, không có BootstrapBondVault hay ETH collateral. Không cần có pool trước mining. Token trong pool, số dư ví và vị thế LP không có quyền xác nhận; chỉ token thực nạp escrow và active mới tính vào snapshot. Registry/quorum dưới đây vẫn chưa được thực thi onchain.

- Tiền gửi mới chờ 7 ngày rồi có hiệu lực ở kỳ tiếp theo. Thời gian 7 ngày là tham số nghiên cứu, không phải bảo đảm chống mua chuộc hay cá voi.
- Mỗi ngày dùng snapshot cố định của các khoản cọc đã hoạt động tại ranh giới bắt đầu ngày. Danh sách, khóa ký, số cọc và tổng trọng số phải có bằng chứng từ Base; relayer không được tự chọn danh sách nhỏ hơn.
- Chụp snapshot có thể gọi trễ nhưng phải truy vấn checkpoint lịch sử đúng ranh giới. Không dùng danh sách của lúc người gọi bấm nút và không cần giao dịch đúng một giây cụ thể.
- Yêu cầu rút có hiệu lực khỏi các kỳ tương lai tại ranh giới tiếp theo. Cọc tiếp tục bị khóa ít nhất 30 ngày từ ngày cuối có trách nhiệm, và dài hơn nếu còn vụ việc chưa xử lý. Top-up, đổi khóa, rút một phần không được xóa trách nhiệm cũ hoặc nhân đôi trọng số.
- Stake bị phạt không tự làm giảm mẫu số của kỳ đang xét. Một khoản cọc có thể chịu nhiều trách nhiệm chưa chốt; không cộng lặp nó khi ước lượng bảo mật nhiều ngày.
- Cọc tối thiểu mỗi validator đã chốt **1.000.000 TOKENCAST**. `MIN_TOTAL_BOND` của cả mạng vẫn cần chốt trước deployment; nếu muốn bootstrap chỉ bằng dev thì phải phù hợp số thực nạp, không tự đặt ngưỡng trong code. Ngưỡng mỗi validator không tự xác định ngưỡng toàn mạng hoặc chi phí tấn công. Số token cọc danh nghĩa không bảo đảm an toàn cho pool ngày đầu 104.989.500 token.
- Khi chưa đủ cọc tối thiểu: chưa nhận kết quả. Nếu tới launchTime vẫn chưa sẵn sàng, lịch phát hành hiện tại vẫn trôi và ngày bị bỏ lỡ không được bù; phải lên lịch bootstrap trước launchTime. Không tự đặt lại lịch phát hành.

Khi operator rời mạng đúng điều kiện, họ nhận lại cọc TOKENCAST còn lại sau nghĩa vụ/phạt; không có khoản ETH collateral để hoàn. Founder được premine nhưng vẫn phải nạp cọc và chịu cùng điều kiện gia nhập. Chỉ dev active nghĩa là dev giữ 100% trọng số, không được gọi giai đoạn đó là đã phi tập trung. Cọc node và stake DAO là hai escrow riêng, không tính cùng token hai lần. Mua/nhận token không mặc nhiên là stake hoặc bằng chứng đủ điều kiện bonus node.

Chưa có khoản thu nhập riêng được đảm bảo cho validator: bonus ×5 chỉ dành cho miner đủ điều kiện, đã có hệ số ×100 thì không tăng thêm. Một validator không mine sẽ chịu chi phí vận hành/gas mà không tự nhận token. Phải đo chi phí, động lực giữ cọc và nguồn trả prover/relayer trước khi gọi mô hình là bền vững; không tự trích 5% staking hoặc tăng phát hành để bù chi phí. Cọc nhỏ so với giá trị có thể tác động không tạo an toàn kinh tế chỉ nhờ có nhãn “PoS”.

## 3. Snapshot nguồn và dữ liệu đủ để tính lại

Tất cả node phải dùng cùng một checkpoint Farcaster cho cùng ngày. Hướng đề xuất: checkpoint finalized cuối cùng tại/before cutoff, kèm checkpoint kế tiếp để chứng minh đã đi qua cutoff, và các shard root liên quan. Phải định nghĩa chính xác quy tắc timestamp, thứ tự và chuyển phiên bản theo một release Snapchain cụ thể; không giả định API hiện có đã cung cấp đủ bằng chứng.

Một `SourceCheckpointVerifier` trên Base là điều kiện bắt buộc của bản đầy đủ. Nó phải xác minh chuỗi checkpoint, chữ ký/chứng chỉ commit, cấu hình validator và các lần chuyển bộ validator. Nếu cấu hình đến từ contract trên chain khác, cần xác minh state/receipt đã finalized của chain đó; URL RPC tự nó không phải bằng chứng. Mốc tin cậy ban đầu và chính sách khôi phục đồng bộ phải công khai.

Worker phải chứng minh/kiểm tra:

- Tính liên tục và đầy đủ của tất cả shard liên quan, không chỉ chữ ký của vài message được chọn.
- Quyền signer, FID, ví nhận, follow/unfollow, thay đổi key và trạng thái tại checkpoint; phân biệt timestamp người dùng khai với lúc message được nhận vào chain.
- Toàn bộ tập miner hợp lệ, các phiên 24 giờ, cast trùng, phiên chồng nhau và điều kiện phải claim phiên trước. Chữ ký ví chứng minh quyền ví, không tự chứng minh quyền FID hoặc số follower.
- Tập follower là các FID hợp lệ theo policy; không xem 1 FID = 1 con người. Chống bot/follow vòng tròn vẫn là bài toán riêng, không được giải quyết chỉ bằng PoS.
- Dữ liệu lịch sử đã bị nguồn prune phải có snapshot/archive được xác thực. Thiếu dữ liệu thì dừng, không thay bằng JSON từ operator.

Farcaster vẫn có tập validator và cơ chế quản trị nguồn riêng. Cộng đồng MineCast không tự tái tạo được sự thật Farcaster nếu nguồn bị chiếm quyền hoặc dữ liệu mất hoàn toàn. Full read node loại bỏ phụ thuộc một API, không loại bỏ phụ thuộc giao thức nguồn.

## 4. Bằng chứng đúng luật thay cho khóa một binary

Đề xuất dài hạn dùng một chương trình tính reward có đặc tả công khai và verifier validity proof (ví dụ zkVM). Người vận hành được thay client/OS/cloud; kết quả phải thỏa cùng luật đã ghim. Không dựa vào PCR0/Nitro để quyết định tính hợp lệ trong phương án này.

Public inputs tối thiểu: chainId, distributor, phiên bản policy, ngày/cutoff, source checkpoint đã xác thực, snapshot validator, registry phiên, work-roster hash, claim root, tổng weight, allocated và số leaf. Chứng minh tính đủ của input và liên kết nó với nguồn đã xác thực, không chỉ chứng minh tính toán trên một file do người nộp tự chọn.

Program phải áp dụng đúng `allocation.mjs`: `min(pool × weight / totalWeight, pool / 100)`, floor số nguyên, FID/ví duy nhất, cap ×100, kiểm tra toàn bộ eligible miner và total, không phân phối lại phần chạm trần. Đầu vào gồm cả roster đã đóng để không bỏ sót người có bonus node.

**Chưa có circuit/zkVM guest, SourceCheckpointVerifier hoặc verifier Solidity cho các yêu cầu này.** Đây là phần nghiên cứu khó và có thể tốn tài nguyên lớn. Không được thay bằng tham số `verified=true`, chữ ký founder hoặc Merkle proof đơn thuần rồi gọi là đã xong. Nếu triển khai quorum-only trước, phải gọi đúng là oracle dựa vào đa số cọc, có thể nhận follower sai khi đa số thông đồng; không bật đường đó như fallback âm thầm trong cùng contract.

## 5. Chứng chỉ xác nhận theo stake

Đề xuất xác nhận phải có **hơn 2/3 tổng cọc đang hoạt động ở snapshot**, không phải hơn 2/3 số node online hoặc số người trả lời:

`signedStake × 3 > totalActiveStake × 2`

Với tổng cọc 100 đơn vị, 67 đủ, 66 chưa đủ. Trong triển khai uint256 dùng phép chia/làm tròn an toàn thay vì nhân có thể overflow. Tổng phải dương và đạt `MIN_TOTAL_BOND`.

- Mỗi khóa chỉ được tính một lần. Chia cùng một lượng cọc TOKENCAST thành 600 node không làm tăng tổng trọng số. Không có trợ cấp theo số địa chỉ hoặc làm tròn lên mỗi vị thế.
- Chữ ký EIP-712 ràng buộc chain, contract, policy, ngày, checkpoint nguồn, validator snapshot, phase và toàn bộ digest kết quả. Không ký URL hoặc root rời ngữ cảnh.
- Tất cả validator có thể ký, không có nhóm 3/5 do founder chọn. Mọi người có thể gom và nộp chữ ký theo batch; kiểm tra gas trước khi chọn số lượng validator mục tiêu.
- Base sắp thứ tự và contract chốt một kết quả mỗi ngày. Đây là chứng chỉ oracle, không phải một giao thức fork-choice riêng hay bản Ethereum thu nhỏ.
- Nếu ít nhất 1/3 trọng số từ chối ký, ngày đó có thể không chốt. Không hạ ngưỡng theo số node online hoặc chuyển sang khóa admin. Ngày timeout dùng hạn V4, không bù phát hành.
- Người nắm hơn 2/3 cọc có thể tự tạo chứng chỉ. Với verifier đầy đủ, họ vẫn không thể chứng minh phép tính sai, nhưng có thể từ chối ký và làm hệ thống dừng. Với quorum-only, họ còn có thể thống nhất báo cáo giả.
- DAO Yes/No không có quorum như trước là một quyền khác. Không dùng cơ chế đa số đơn giản của DAO để sửa kết quả follower.

Hai chứng chỉ mâu thuẫn cùng snapshot đều đạt hơn 2/3 thì phần giao của người ký vượt 1/3 trọng số. Chỉ áp dụng lập luận này khi snapshot, domain, phase giống nhau và chữ ký không bị giả. Mô hình số học đi kèm minh họa tính chất đó, không chứng minh mạng chạy BFT an toàn.

## 6. Phạt có bằng chứng, không phạt vì thiểu số

Đề xuất cho bất kỳ ai gửi bằng chứng, không cần stake TOKENCAST đủ 30 ngày hoặc xin phép:

| Hành vi | Xử lý đề xuất |
|---|---|
| Hai chữ ký cho digest khác nhau trong cùng ngày/snapshot/phase | Xác minh hai chữ ký và phạt cọc theo trách nhiệm đã khóa; loại khỏi các kỳ tương lai |
| Báo cáo sai dữ liệu hoặc tính toán | Verifier từ chối; chỉ phạt người ký khi contract có bằng chứng khách quan về lỗi cụ thể |
| Ký khác số đông nhưng chưa chứng minh sai | Không phạt |
| Không online/không ký | Không có ghi nhận tham gia; có thể gây ngừng chốt, không tự coi là gian lận |
| API timeout, tố cáo không có proof | Không tự đóng băng root hợp lệ hoặc tịch thu cọc |

Một chữ ký sai trên số follower không tự cung cấp proof rằng follower sai. Không hứa slashing dữ liệu nguồn khi verifier nguồn chưa xây xong. Tham số burn cọc/thưởng người báo lỗi phải được thiết kế và kiểm thử riêng, trả từ khoản phạt thực tế, không mint TOKENCAST thêm. Cần giới hạn chi trả theo escrow còn lại để một cọc không bị trả thưởng nhiều lần.

Trước ngày FINAL, node chỉ ký một terminal digest cho ngữ cảnh đã xác định. Nếu cần sửa báo cáo hay nhiều round, phải thiết kế locking/unlocking an toàn trước khi bổ sung; không cho đổi phiếu tùy ý rồi vẫn dùng luật phạt một-phiếu/ngày. Proposal không tự động giải quyết liveness khi các node đã khóa vào nhiều kết quả khác nhau.

## 7. Bonus node ×5 và dữ liệu claim

Hai bước tính hiện tại vẫn cần để tránh vòng lặp “thưởng phụ thuộc danh sách người vừa tính bảng thưởng”:

1. Tính bảng gốc từ cùng dữ liệu nguồn. Miner có phiên hợp lệ có thể nộp proof thực thi hợp lệ gắn FID/ví và digest bảng gốc trong cửa sổ 6 giờ hiện tại. Validator và read node đều có thể làm việc này; tiền cọc không tự tạo quyền ×5.
2. Sau khi roster đóng, tính bảng cuối dùng ×5 cho đúng FID/ví có biên nhận, cap ×100 và trần 1% như cũ. Validator ký bảng cuối.

Proof tính toán gắn FID/ví không chứng minh rằng người đó sở hữu một máy riêng, tự tính thay vì thuê prover, hoặc online 24 giờ. Nếu yêu cầu chính xác “mỗi người tự chạy node” thì cần tiêu chí khác; không thể đồng thời hứa loại bỏ Nitro và giữ nguyên bằng chứng phần cứng của V4 hiện tại. Đây là tradeoff phải công bố trước khi đổi điều kiện bonus.

Root và link IPFS không đảm bảo miner lấy được proof. Đề xuất `PublicationInbox`: công bố bảng claim chuẩn hóa theo chunk bằng calldata/event trên Base, kiểm tra số leaf, thứ tự, tổng và Merkle root khớp kết quả. Chỉ FINAL khi đủ bảng và proof. Ai cũng có thể tải từ lịch sử Base rồi dựng Merkle proof, không cần website của founder. Toàn bộ dữ liệu xã hội đầy đủ vẫn ở archive/P2P; không nhét toàn bộ Farcaster lên Base.

Chi phí publish, kích thước bảng, giới hạn gas và thời gian tới hạn phải benchmark với 1k/100k miner. Nếu không khả thi, thay bằng thiết kế DA khác và công bố giả định tin cậy mới; không coi link HTTP/IPFS là tương đương. Proof về phép tính cũng không chứng minh người khác tải được file.

## 8. Luồng một ngày và trải nghiệm người dùng

`OPEN -> SOURCE_READY -> WORK_ROSTER_CLOSED -> PROVEN + PUBLISHED + CERTIFIED -> FINAL -> CLAIM -> CLOSED`

- App bất kỳ cho người dùng cast/start; node quan sát việc cast thật được nhận vào nguồn, kiểm tra quyền FID/ví. Có thể trả trạng thái phiên nhanh nhưng đó là pending, không phải token đã chắc chắn mint.
- Start-time follower snapshot có thể là một policy khác. Đề xuất này giữ snapshot/ngày của V4; chưa thực hiện chuyển sang snapshot tức thời mỗi phiên. Chia pool có tổng weight toàn ngày thì reward chính xác chỉ biết sau khi đủ đầu vào.
- Sau cutoff: xử lý checkpoint, 6 giờ ghi work, tạo proof và công bố bảng, thu chữ ký. Node đồng bộ liên tục; chỉ settlement và mẫu số phân bổ phải chờ ngày kết thúc.
- Giai đoạn nghiên cứu giữ 48 giờ trước activation để đối chiếu công khai, nhưng không dùng vote chủ quan để bác một proof hợp lệ. Với verifier đầy đủ, cần đánh giá lại việc giữ delay này trước mainnet; chưa hứa claim tức thời.
- Giữ hạn kết quả 8 ngày của V4 và claim 24 giờ từ activation. Nếu không đủ các điều kiện trước hạn, ngày đó không phát hành; state machine phải cho ngày kế tiếp tiếp tục độc lập nếu có đủ dữ liệu phiên/claim.
- UI tách `Mining`, `Đang chốt ngày`, `Có thể claim`, `Đã xác nhận onchain`. Claim thành công chỉ dựa receipt/event hợp lệ; không hiển thị pending là đã về ví.

## 9. Founder rời đi, mất node và nâng cấp

Các node lấy peer từ nhiều bootstrap độc lập, registry endpoint công khai và cấu hình thủ công. Endpoint chỉ giúp discovery, không phải nguồn sự thật. Công bố mã nguồn, giấy phép, build, test vectors, schema, snapshot, cách tạo proof và cách tự chạy app. Có thể phát triển nhiều client cùng luật; audit và reproducible build vẫn cần dù không ghim một binary duy nhất.

Founder không có bypass để thêm root, duyệt node, sửa follower, lấy cọc hoặc đổi supply. Nếu founder có 20% stake và 80% còn lại hoạt động, có thể vẫn đủ xác nhận; nếu founder có 40%, phần 60% còn lại không đủ. Không tuyên bố tự sống chỉ vì có thêm vài địa chỉ.

Không hứa luôn chạy khi hơn 1/3 cọc biến mất. Cần nghiên cứu riêng cơ chế thoát validator bất hoạt, trách nhiệm và khả năng bị lợi dụng trước khi thêm; bản đề xuất không tự giảm denominator của kỳ đang chốt. Nguồn Farcaster dừng, Base dừng hoặc verifier lỗi cũng có thể làm mining dừng.

Chốt verifier và luật bất biến bảo vệ khỏi admin đổi luật nhưng làm nâng cấp nguồn khó. Cần version/migration công khai trước deployment. Không thêm proxy admin bí mật hoặc “emergency signer” để che vấn đề. Các phiên bản không tương thích phải có kế hoạch người dùng tự nguyện chuyển, không thể hứa giữ cùng địa chỉ bất biến mà luôn sửa được.

## 10. Những thành phần phải xây và điều kiện thử nghiệm

| Thành phần đề xuất | Hiện trạng |
|---|---|
| `TokenCastOpenV4`: premine dev 2,1 triệu, mining 99,99%, trần ngày/lifetime | Có Solidity và test EVM local, chưa deploy; bootstrap admin vẫn chọn distributor một lần |
| `MineCastLiquidityLockerV4`: thêm thanh khoản từ token đã sở hữu và ETH, LP khóa vĩnh viễn | Có Solidity và test Uniswap V2 local; pool mới/cũ, hoàn ETH dư; chưa chốt cấu hình Base hoặc tạo pool thật |
| `NodeBondRegistry`: TOKENCAST tự sở hữu nạp escrow, checkpoint weight/key, pending activation/exit | Chưa viết |
| `SourceCheckpointVerifier`: kiểm tra nguồn, validator history, chain dependencies | Chưa viết; nghiên cứu định dạng proof trước |
| `RewardValidityVerifier`: proof đầy đủ dữ liệu và phân bổ | Chưa viết; benchmark zkVM/circuit trước |
| `DailyCertificate`: chữ ký theo snapshot, threshold, replay protection | Chỉ có mô hình số học minh họa, chưa có contract |
| `PublicationInbox`: công bố bảng claim và kiểm tra root | Chưa viết |
| `EvidenceSlasher`: chứng cứ mâu thuẫn, escrow, exit liabilities | Chưa viết |
| `Distributor` nối các gate | Cần bản mới; V4 hiện đang dùng Nitro |
| P2P worker, archive, API/proof server | Chưa có node vận hành hoàn chỉnh |

Các thử nghiệm bắt buộc: chia một cọc ra nhiều khóa không tăng quyền; snapshot không đổi giữa kỳ; phát lại chữ ký sai chain/ngày bị từ chối; equivocation có bằng chứng; không phạt thiểu số; snapshot nguồn giả/thiếu shard/stale bị từ chối; đa số ký reward sai vẫn fail verifier; bảng claim thiếu không FINAL; người rút còn chịu trách nhiệm; no-quorum timeout không mở claim; founder tắt node, các bên độc lập vẫn tạo proof/claim khi đủ trọng số; lấy lại dữ liệu từ nguồn công khai không cần server founder.

Không đánh giá bằng một tỷ lệ “phi tập trung %”. Cần công khai phân bổ cọc theo người vận hành thực tế, cloud/client/source diversity, khả năng tái lập dữ liệu, điểm quản trị nguồn, chi phí tấn công và kết quả failover. Nhiều địa chỉ không chứng minh nhiều người.

## Chạy mô hình số học

```powershell
Set-Location 'C:\Users\nhath\.gemini\antigravity\scratch\minecast-clean'
node research/v4/node/quorum-model.mjs
node research/v4/node/bootstrap-model.mjs
node --test research/v4/node/quorum-model.test.mjs
node --test research/v4/node/bootstrap-model.test.mjs
```

Mô hình chỉ tính ngưỡng từ một snapshot giả định; không kiểm tra chữ ký, không lấy Farcaster, không tạo proof, không gửi giao dịch. Một kết quả đủ quorum trong mô hình **không có nghĩa báo cáo mining đúng**.

## Nguồn đối chiếu

- [Bitcoin: full node tự kiểm tra block và Proof of Work](https://developer.bitcoin.org/devguide/block_chain.html).
- [Ethereum: stake, attestation, finality và slashing](https://ethereum.org/en/developers/docs/consensus-mechanisms/pos/). Các tham số MineCast trong tài liệu là đề xuất riêng, không sao chép thông số ETH.
- [Snapchain: read node và validator](https://snapchain.farcaster.xyz/node-types). Read node mở cho mọi người; quyền validator nguồn và cách cập nhật cấu hình là lớp riêng cần kiểm tra.
- [Snapchain whitepaper](https://snapchain.farcaster.xyz/whitepaper). Đây là nguồn thiết kế; phải đối chiếu binary/protocol version thực dùng trước khi viết verifier.
