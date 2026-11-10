# Open V4 Quorum — contract candidate

Cập nhật 2026-11-09 (Asia/Saigon). **Code local và kiểm thử đã có; chưa phải bản đã audit hoặc được phép phát hành mainnet.** Không có giao dịch công khai, push GitHub hay thay app production trong công việc này.

Hai quyết định của chủ dự án được áp dụng: xác nhận bằng chữ ký **hơn 2/3 tổng cọc node**, chấp nhận quorum khai sai dữ liệu xã hội; **tổng cọc tối thiểu 1 triệu TOKENCAST**, cho phép một node dev bootstrap. Bản này thay yêu cầu Nitro/ZK/source proof của các tài liệu nghiên cứu trước, không tuyên bố bảo mật tương đương Ethereum/Bitcoin.

## Bộ contract và công cụ

| Thành phần | Trách nhiệm |
|---|---|
| `contracts/v4/open/TokenCastOpenV4.sol` | ERC-20, premine dev một lần, trần theo ngày/thời gian/mint trọn đời; khóa distributor một lần |
| `contracts/v4/open/MineCastNodeRegistryV4.sol` | Cọc TOKENCAST thực, snapshot trọng số từng ngày, chờ gia nhập/rút, burn cọc khi có bằng chứng ký mâu thuẫn |
| `contracts/v4/open/MineCastRewardPolicyV4.sol` | Bảng boost cố định, node ×5, trần tổng boost ×100, trần mỗi allocation 1% pool |
| `contracts/v4/open/MineCastOpenDistributorV4.sol` | EIP-712 quorum, publication theo Merkle, kiểm tra tổng/phân bổ, claim trực tiếp, phần dư 5/95, sổ mining tháng |
| `contracts/v4/open/MineCastOpenStakingV4.sol` | Stake khóa 30 ngày, snapshot thưởng cố định đầu kỳ, vote power đã trưởng thành, pool thưởng riêng tiền gốc |
| `contracts/v4/MineCastMonthlyDaoV4.sol` | Tháng lẻ air/tháng chẵn burn, Yes/No theo mature stake, giữ riêng ngân sách round; không có ví admin rút treasury |
| `research/v4/open-report.mjs` | Dựng report, allocation, proof và typed data để node ký; **không** tự xác thực Farcaster |
| `research/v4/package-open.mjs` | ABI, bytecode, compiler standard input đầy đủ nguồn, manifest hash |
| `research/v4/prepare-open-deployment.mjs` | Tạo giao dịch deploy chưa ký theo nonce/địa chỉ đã chọn; không broadcast |
| `research/v4/verify-open-deployment.mjs` | Đọc chain, đối chiếu runtime với artifact và mọi liên kết token/staking/DAO/registry/distributor |

Không có proxy/upgrade, emergency mint, chức năng đổi lịch phát hành, đổi bảng boost, thay treasury hoặc thay distributor sau finalization. DAO chỉ có hai hành động cố định; không tự sửa code hay bổ nhiệm backend. Việc chọn distributor ban đầu vẫn là trách nhiệm bootstrap admin: kiểm tra `token()` không chứng minh distributor an toàn. Phải kiểm tra cả runtime/binding trước giao dịch khóa vĩnh viễn.

## Tokenomics được cưỡng chế

- Tối đa mint trọn đời 21 tỷ; burn không làm trần mint tăng lại.
- 2.100.000 premine (0,01%) vào ví dev đã chọn, có thể chuyển nhượng. Không bắt buộc tự cọc hoặc cấp thanh khoản.
- Mining 20.997.900.000. Ngày 0 là 104.989.500; ngày sau giảm 0,5%. Tính số nguyên với precision `1e36`, làm tròn xuống. Không cộng bù ngày không phát hành. Cuối đường cong, ngân sách <1 wei token trở thành 0; không hứa đào vô hạn hoặc đạt chính xác 21 tỷ.
- `amount = min(pool * weight / totalWeight, pool / 100)`. Không phân bổ lại phần bị chặn trần. Chỉ khi tất cả entries có tổng weight/amount khớp report mới được mở claim.
- Boost follower: dưới 10 ×1; 10 ×2; 500 ×4; 1k ×6; 2k ×10; 5k ×18; 10k ×30; 25k ×50; 50k ×75; 100k ×100. Node có `nodeWork=true` nhân 5, tổng tối đa ×100. **2k follower + node = ×50**. Đây là trọng số, không phải reward cố định.
- Mỗi FID và ví chỉ một allocation trong một ngày. Cast hash không được dùng lại. Tính đúng của FID/ví, follower, phiên hợp lệ, chống bot, không chồng phiên và nodeWork vẫn cần quorum kiểm chứng từ nguồn.
- Phần **chưa phân bổ**: 5% sang staking, 95% sang DAO. Phần đã phân bổ nhưng chưa claim không tính vào surplus; quá hạn mining 24h thì không mint.

## Cọc và oracle

Token cọc node tách khỏi stake DAO. Mỗi signing key đăng ký một lần, cọc ít nhất 1 triệu. Chủ ví nạp cọc là operator, signing key có thể khác ví giữ tiền; key ký dùng ECDSA, không phải ERC-1271 contract wallet. Cọc không tự cấp thưởng mining; operator vẫn cần phiên hợp lệ và quorum công nhận nodeWork.

Gia nhập chờ 7 ngày, sau đó ai cũng gọi `activateNode(key)`. Có hiệu lực từ ngày kế tiếp; trước launch thì hiệu lực ngày 0. Số cọc/key không sửa được; muốn thêm/đổi key thì tạo vị thế mới và chờ lại. Operator yêu cầu exit; mất quyền từ ngày kế tiếp, rút sau 30 ngày kể từ ranh giới exit. Không có ban tùy ý hoặc phạt chỉ vì offline.

Mẫu số là **toàn bộ cọc tại đầu ngày**, kể cả node offline. Quorum là `floor(2 * total / 3) + 1 wei cọc`. Chia một khoản thành nhiều node không tăng quyền. Ngưỡng toàn mạng 1 triệu cho phép founder đơn lẻ có 100% quyền chứng nhận. Nếu founder offline giữ ít nhất 1/3 tổng cọc, các node còn lại không đạt >2/3. Một node không thể yêu cầu xóa cọc offline của người khác. Không có tự động tiếp quản bởi top holder.

Ai cũng có thể chuyển tiếp chữ ký theo lô ≤100. Domain ký khóa chain ID, distributor, version; message khóa ngày, root, weight, allocation, số leaf, source hash và policy hash. Duplicate signer không được cộng trọng số. Source hash là cam kết dữ liệu, **không phải proof nguồn đúng**.

Hai chữ ký cùng key/cùng ngày nhưng report khác nhau là bằng chứng khách quan để `proveEquivocation`. Contract burn toàn bộ cọc còn chịu trách nhiệm của key đó; không trả thưởng tố cáo. Mọi người có thể gửi evidence, không cần root thứ hai đủ quorum. Nếu chứng chỉ chưa mở claim mất ngưỡng sau evidence, ngày đó bị khóa. Hai chứng chỉ đủ quorum mâu thuẫn cũng khóa ngày đó. Không sửa root/revote/khôi phục ngày bị khóa; budget ngày đó không được phát hành. Evidence phải đến trước 30 ngày sau ngày bị vi phạm; slashing không hoàn tác token đã claim hoặc tái tính snapshot quá khứ.

**Không slash tự động việc khai sai follower nếu chỉ có một report:** Base không có sự thật Farcaster để phán xét. Quorum thông đồng vẫn có thể bỏ miner thật, khai follower/nodeWork sai hoặc xác nhận danh sách giả trong các trần onchain. 48 giờ review không biến dữ liệu đó thành đúng và không có nút khiếu nại tùy ý cho phép một ví khóa mạng.

## Mốc thời gian mining và claim

Gọi `L = launchTime`, ngày cohort `d` chứa phiên bắt đầu trong `[L+d*24h, L+(d+1)*24h)`.

1. Mỗi phiên có `startedAt` trong ngày đó, đã qua đủ 24h trước publication. Quorum xác nhận đây là phiên/cast/owner hợp lệ.
2. Chữ ký report được gửi sớm nhất **30h sau cuối ngày cohort**: chờ các phiên bắt đầu muộn hoàn tất 24h rồi thêm 6h thu thập work. Report phải đủ quorum còn hơn 48h trước hạn kết quả.
3. Công bố toàn bộ allocations và proof trong các lô ≤100. Contract tự tính amount, kiểm tra Merkle, FID/ví/cast trùng, tổng weight và tổng allocation. Sau bước này quyền nhận nằm trong state/events của Base, không cần API riêng để tải proof lúc claim.
4. Chờ 48h kể từ certificate, đủ publication, không contested, gọi `activateDay` trước **8 ngày sau cuối cohort**. Ai cũng có thể gọi.
5. Miner có **24h từ activateDay** để tự `claim(day)` bằng ví nhận. Chỉ chữ ký giao dịch của ví, không cần server claim signer. Hết đúng deadline là đóng.

**Hết 24h đào không đồng nghĩa claim ngay.** Với certificate sớm nhất, ngày 0 mở claim khoảng `L + 4 ngày 6 giờ`. App phải hiển thị các trạng thái đang đào / chờ node chốt / chờ review / có thể claim / hết hạn. UI/backend hiện tại chưa dùng luồng này. Ngày bị thiếu quorum, thiếu dữ liệu hoặc contested không mở claim; không có đường admin cứu hoặc phát bù.

## Staking và DAO

Staking khóa 30 ngày từ lần nạp gần nhất; top-up reset cả vị thế và xóa quyền vote tương lai cho tới khi trưởng thành lại. Sau đủ hạn, gọi `activateGovernancePower()` trước lúc mở round. Vote dùng checkpoint block trước giao dịch mở round; withdraw/chuyển/stake lại không tạo thêm quyền trong round cũ. Có thể rút tiền gốc đã đủ hạn mà không chờ vote kết thúc.

Reward staking chia theo số token ở timestamp **ngay trước ranh giới epoch 30 ngày**, không theo thời gian stake trung bình. Gọi snapshot trễ vẫn lấy cùng timestamp. Có thể rút sau snapshot mà vẫn có phần thưởng snapshot đó; đây là policy của bản này. Funding luôn sang epoch kế tiếp. `finalizeEpoch` theo thứ tự và tự snapshot lịch sử; không cần gọi đúng ngày đầu. Epoch không có stake chuyển reward sang kỳ sau. Claim staking 90 ngày; quá hạn chuyển phần chưa nhận bằng `sweepUnclaimed`. `rewardLiability` theo dõi nghĩa vụ thưởng riêng với `totalStaked`; không lấy tiền gốc trả thưởng. Token chuyển thẳng ngoài `fundFutureRewards` không tự được hạch toán thưởng.

Mining ledger chỉ ghi số thực claim, phân tháng UTC theo **ngày cohort bắt đầu**, không theo ngày bấm claim. `finalizeMonth(nextMonthStart)` gọi sau mốc 00:00 ngày đầu tháng kế +10 ngày. Sau đó ledger tháng bất biến; ngày mất quorum không chặn chốt tháng.

DAO mở một round/tháng trong ngày 8–21 UTC, nhưng do chốt tháng nên sớm nhất thực tế là **ngày 11**. Không còn lịch 1 và 15 cũ. Tháng lẻ airdrop, tháng chẵn burn. Vote 7 ngày, Yes>No thắng; không quorum turnout; hòa/0–0 thất bại. Thắng chờ thêm 72h rồi ai cũng settle. Airdrop budget tối đa 10% mining thực claim tháng trước; burn tối đa 5% cùng cơ sở, cả hai còn bị chặn bởi treasury khả dụng. Airdrop theo tỷ lệ mining thực claim; nhận trong 90 ngày, không phải 24h của mining. Ngân sách round được giữ riêng. Bỏ lỡ mở round thì tháng đó không có vote; treasury vẫn nằm trong contract.

## Build, kiểm thử và hiện trạng

Khóa Solidity **0.8.38+commit.1835d247**, optimizer 200, EVM Cancun, OpenZeppelin **5.6.1**. Giữ package-lock; compiler script từ chối phiên bản khác và runtime >24.576 byte. Dùng các mẫu checkpoint, CEI và giới hạn vòng lặp như [OpenZeppelin Checkpoints](https://docs.openzeppelin.com/contracts/5.x/api/utils#Checkpoints) và [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html). Đây không phải chứng nhận an toàn từ các nguồn đó.

Kết quả lần chạy 2026-11-09: **85/85 tests pass**, gồm 23 scenario Open V4 trên Anvil, hồi quy Nitro, Uniswap V2 local và mô hình số học/nguồn. Có 160 đối chiếu boost trong EVM, chặn replay/quorum/claim, minh chứng double-sign, principal/reward solvency, mature vote snapshot, chốt tháng, air/burn, thực thi kế hoạch deploy và kiểm tra bytecode. Batch 100 miner dùng **8.819.538 gas trên Anvil**, không phải báo giá phí Base. Chưa benchmark public testnet hay 10k miner thực. Compiler có cảnh báo tên identifier tương lai ở thư viện OZ, không có lỗi compile.

Không gọi đây là formal verification, Slither audit, fuzz toàn trạng thái hoặc fork-mainnet test: chưa chạy các loại đó. Không có auditor độc lập. Trước khi dùng tiền thật cần public testnet nhiều operator, kiểm thử worker/indexer chống ký hai report khi restart/reorg, dữ liệu ngày/tháng và tích hợp ví/app; sau đó audit đúng artifact đã ghim. [Base cũng hướng dẫn verify source và audit trước production](https://docs.base.org/base-chain/security/avoid-malicious-flags).

```powershell
Set-Location 'C:\Users\nhath\.gemini\antigravity\scratch\minecast-clean'
npm.cmd run v4:compile
# Anvil phải trên PATH hoặc đặt ANVIL_BIN tới executable đã cài.
npm.cmd run v4:test
npm.cmd run v4:artifacts
```

Artifacts nằm trong `research/v4/build.local/` (gitignore): ABI, init bytecode, runtime template, immutable references, metadata, standard input đầy đủ nguồn, manifest/source hashes. Không lưu private key. Build bundle không tạo deployment hoặc thay đổi Vercel.

## Kế hoạch triển khai để review

1. Điền bản sao `open-deployment.example.json` vào file local: chain, deployer, ví dev, pending nonce, launch timestamp ít nhất 8 ngày phía trước (nên dư thời gian vận hành). Không tự dùng lại địa chỉ signer/treasury testnet làm ví dev.
2. `npm.cmd run v4:plan -- path/to/config.local.json` tạo `build.local/deployment-plan.json`. Đây là dữ liệu giao dịch **chưa ký**. Chain 84532 là Base Sepolia, 8453 là Base mainnet theo [Base chain ID docs](https://docs.base.org/base-chain/api-reference/ethereum-json-rpc-api/eth_chainId).
3. Deploy theo thứ tự token → staking → DAO → registry → distributor. Kiểm tra nonce liên tục: giao dịch chen vào làm sai mọi địa chỉ dự đoán phía sau. Chọn đúng network và estimate gas từng bước trên RPC; script không broadcast.
4. Verify source/runtime/constructor/component addresses trước `finalizeDistributor`. Giao dịch này khóa địa chỉ duy nhất vĩnh viễn, xóa bootstrap admin; nếu sai thì phải triển khai bộ mới. Sau đó chạy công cụ đọc `verify-open-deployment.mjs` với plan/artifacts đã review.
5. Dev approve registry và `registerNode(signingKey, 1000000e18)` bằng tài sản của mình. Chờ 7 ngày, `activateNode` trước launch. Tool đọc đủ bond không chứng minh node process đang chạy hoặc operator độc lập.
6. Chạy worker/node thu thập và xác minh social data, lưu report đã ký bền vững để không ký hai digest cho cùng chain/distributor/ngày, phân phối chữ ký/input/proof công khai. Bất cứ relayer nào trả gas nộp chữ ký, publish, activate, chốt tháng/epoch/round. Contract không tự chạy theo đồng hồ.
7. Tích hợp UI/API Open V4 đã có riêng và bật bằng cấu hình; xem [MINIAPP-INTEGRATION.md](MINIAPP-INTEGRATION.md). Cần địa chỉ deploy thật, migration và worker quorum/relayer vận hành; chạy một vòng cast → chốt → claim → stake → vote hoàn chỉnh trên Sepolia trước khi quyết định mainnet. V2 balance/history không tự migrate.

Ví dụ kiểm tra read-only sau deploy:

```powershell
$env:V4_READ_RPC_URL = 'RPC_URL_CUA_MANG_VUA_DEPLOY'
node research/v4/verify-open-deployment.mjs research/v4/build.local/deployment-plan.json
```

## Phần phi tập trung và phần còn tin cậy

| Đã cố định onchain | Còn phụ thuộc |
|---|---|
| Trần cung, decay, boost formula, 1% cap, surplus/claim/month math | Quorum khai đúng follower, cast, FID–wallet, chống bot, nodeWork và danh sách đầy đủ |
| Ai đủ cọc đều đăng ký, bất kỳ relayer nào nộp chữ ký | Ban đầu một operator có toàn quyền oracle; cọc TOKENCAST có giá trị bảo mật phụ thuộc thị trường |
| Claim dùng state công khai, không server cho phép từng lần | Đủ quorum và có người trả gas để công bố dữ liệu trước deadline |
| Stake/vote/air/burn hoạt động qua contract, không cần backend chủ dự án | RPC, UI và nguồn dữ liệu cần vận hành; API tập trung vẫn là điểm phụ thuộc nếu mọi node dùng chung |
| Không còn quyền owner sau finalize distributor | Bootstrap chọn đúng bộ contract và audit; lỗi immutable không thể vá tại địa chỉ cũ |

Community có thể làm app/relayer/node khác theo ABI công khai. Founder tắt web/backend không ngăn claim đã kích hoạt hoặc DAO/staking. Mining mới chỉ tiếp tục khi các operator còn chạy đủ >2/3 snapshot và có dữ liệu/relayer. Đây là điều kiện định lượng, không thể diễn đạt trung thực bằng một tỷ lệ “phi tập trung X%”.
