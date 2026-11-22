# Open V4 Quorum — contract candidate

Cập nhật 2026-11-09 (Asia/Saigon). **Code local và kiểm thử đã có; chưa phải bản đã audit hoặc được phép phát hành mainnet.** Không có giao dịch công khai, push GitHub hay thay app production trong công việc này.

Hai quyết định của chủ dự án được áp dụng: xác nhận bằng chữ ký **hơn 2/3 tổng cọc node**, chấp nhận quorum khai sai dữ liệu xã hội; **tổng cọc tối thiểu 1 triệu TOKENCAST**, cho phép một node dev bootstrap. Bản này thay yêu cầu Nitro/ZK/source proof của các tài liệu nghiên cứu trước, không tuyên bố bảo mật tương đương Ethereum/Bitcoin.

## Bản 2 (2026-11-11): phi tập trung hoá và governance

Áp dụng các quyết định ngày 2026-11-11 của chủ dự án; mục này có hiệu lực hơn mọi câu cũ mâu thuẫn bên dưới.

- **Phiên đào onchain.** Miner tự gọi `startMining(fid, castHash)` trên distributor; thời điểm bắt đầu là block của Base. Mỗi ví một phiên mỗi ngày UTC; phiên chạy tới khi cohort đóng lúc 00:00 UTC (policy `Quorum.7`). FID và cast không độc quyền khi bắt đầu, để tránh bị chiếm chỗ. Report phải cam kết đúng `sessionsHash(day)`, và mỗi allocation phải khớp phiên onchain (ví, FID, cast, giờ). Backend intake không còn bắt buộc: node đọc phiên từ chain, app chỉ dùng backend để đổi link cast thành hash và hiển thị ước tính.
- **Không còn luật "claim xong mới đào tiếp".** Mỗi ví đào được mỗi ngày UTC, mở phiên mới ngay từ 00:00 UTC kể cả khi ngày trước chưa claim được. Claim mở trong **7 ngày** sau `activateDay`, và `claimMany(days)` gom nhiều ngày một giao dịch. `startMiningAndClaim(fid, cast, days)` mở phiên mới và claim luôn các ngày đang mở (ngày không claim được thì bỏ qua), nên người đào hằng ngày chỉ trả gas 1 lần/ngày. Miner tự trả gas, không có paymaster: phí rất nhỏ nhưng mỗi tài khoản đào phải có ETH trên Base. Đây là một lớp lọc bot yếu, không thay cho việc lọc bot ở quorum. Quá hạn thì vẫn không mint. Sổ mining tháng chốt sau 16 ngày; vote tháng mở trong ngày 17–28.
- **Node ×5 được contract tự kiểm.** Ví nhận phải là operator của một key đã ký report được certify của ngày trước, và cả chữ ký lẫn certificate phải có trước khi cửa sổ report của ngày đó mở. `nodeKey` nằm trong leaf; quorum không khai khống được, chỉ có thể bỏ sót.
- **Loại node bỏ hoang.** Key không ký report nào trong 14 ngày report (cộng 3 ngày trễ) thì ai cũng gọi được `registry.ejectInactive(key)`. Không phạt; cọc rút lại sau 30 ngày như thoát thường. Cọc bỏ hoang ≥⅓ không còn khoá mạng vĩnh viễn.
- **Governance theo stake.** `MineCastGovernorV4` (OpenZeppelin Governor) dùng mature stake ở block snapshot. Được đề xuất: người có ≥1 triệu stake đã trưởng thành, hoặc operator của một node đang active (`proposeAsNode`). Quorum 10% tổng phiếu active, thắng khi For > Against. Mọi thứ đi qua `TimelockController` 14 ngày; timelock tự làm admin, ai cũng execute được sau hạn.
- **DAO được làm gì.** Chi phần treasury chưa giữ (`MineCastOpenDaoV4.spend`), và giao các **tháng UTC tương lai trọn vẹn** cho distributor mới (`TokenCastOpenV4.scheduleDistributor`). Token vẫn cưỡng chế trần 21 tỷ và ngân sách từng ngày. Mỗi ngày thuộc đúng một distributor: ngày cũ ở lại contract cũ, nên không thể mở lại hay mint bù. `launchTime` phải là 00:00 UTC.
- **Boost đốt vĩnh viễn (`TokenCastOpenV4.buyBoostLevel`).** Đốt L × 1.000.000 TOKENCAST để lên level L, mua lần lượt, tối đa level 9. Level L chỉ mở khi lịch phát hành đã nhả L × 10% ngân sách đào (≈ ngày 22, 45, 72, 102, 139, 183, 241, 322, 460). Mỗi level nhân trọng số **và** trần mỗi ví mỗi ngày thêm 0,2: trọng số = gốc (follower × node, trần 100) × (1 + 0,2L), trần = 1% pool × (1 + 0,2L). Phần boost nằm ngoài trần 100 (tối đa ×280). Level lưu trong token theo ví, nên distributor sau này vẫn đọc được. Level được chốt lúc mở phiên và nằm trong leaf; quorum không cấp level mà phiên không có. Trọng số onchain tính theo đơn vị 1/5 (gốc × (5 + L)). Burn không mở lại trần mint.
- **Bảo vệ governance (2026-11-13).** `MineCastGovernorV4` nhận thêm địa chỉ DAO trong constructor. Quorum hiệu lực của mỗi đề xuất (`proposalQuorum`) = max(10% tổng phiếu, min(1% `releasedSupply` chốt lúc đề xuất, 50% tổng phiếu)); sàn bị chặn ở 50% để governance không tự khóa khi ít người stake. Đề xuất chỉ gồm `dao.spend` cần đa số thường; mọi thứ khác (đổi distributor, đổi tham số governor/timelock) cần thuận ≥ 2/3 của thuận + chống (`needsSupermajority`). Mỗi proposer chỉ có một đề xuất Pending/Active (`ProposerHasLiveProposal`). Staking thêm `delegate(to)`: ủy quyền phiếu mature cho người khác, dùng cho cả Governor lẫn vote DAO hằng tháng; stake và thưởng vẫn của chủ.
- **Airdrop chỉ cho người giữ stake (2026-11-13).** `MineCastOpenDaoV4.claimAirdrop` chỉ trả cho ví có stake (`stakeAtTime` tại lúc vòng mở) ≥ 1/3 số token ví đó đã đào trong tháng trước (`claimedByMonth`); thiếu thì revert `NotEligible`. Phần của người không đủ điều kiện ở lại trong khoản giữ chỗ và quay về quỹ DAO khi hết 90 ngày (`releaseExpiredAirdrop`). Lưu ý UX: mỗi lần nạp thêm stake reset khóa 30 ngày và quyền vote, nên người đào nên stake một lần trước khi vòng mở.
- **Nâng cấp do staker cầm lái (2026-11-13).** Luật công khai nằm ở `CONSTITUTION.md` (tiếng Anh, cho cộng đồng). `research/v4/governance.mjs` nộp/vote/xem/queue/execute đề xuất từ một file JSON và ủy quyền phiếu. Worker tự đi theo `token.distributorForDay(day)` từng ngày, nên khi distributor mới tiếp quản chỉ cần cài bản worker khớp luật, không đổi cấu hình; bản build lệch luật tự từ chối ký. App không còn báo lỗi sau khi chuyển: vẫn xử lý claim ngày cũ, hiện thông báo và khóa nút mở phiên cho tới khi cập nhật app. Registry đếm số ngày được chứng nhận (`certifiedDays`) và ghi nhận key có chữ ký trong bản được chứng nhận (tự động cho batch hoàn tất quorum, còn lại qua `proveCertifiedSignature`, worker tự gọi). Key vắng mặt trong 14 ngày được chứng nhận liên tiếp bị loại bởi bất kỳ ai; khi mạng đứng hẳn (nhóm >1/3 stake ký bản khác), staker dùng `ejectByGovernance` (cần 2/3, timelock 14 ngày).
- **Cam kết trước, công bố sau (từ policy `Quorum.6`, thời gian theo `Quorum.7`).** Cửa sổ báo cáo của ngày d mở đúng lúc cohort đóng, dayEnd(d) = 00:00 UTC, chia 2 giai đoạn. Giai đoạn 1 (30 phút, `COMMIT_WINDOW`): key đang bond nộp `commitReport(day, keccak256(abi.encode(digest, key)))` cho bản tự lập; không ai ký hay công bố được trong lúc này. Giai đoạn 2: `announceReport(day, report, entries)` chỉ chấp nhận đúng bản đã cam kết, và `submitSignatures` mở. Thưởng ×5 của ngày d+1 chỉ dành cho key có cam kết riêng trùng đúng bản được chứng nhận, nên chép bài không được gì. Key bỏ lỡ giai đoạn 1 vẫn ký theo bản người khác được, nhưng không công bố được bản của mình và không có ×5. Báo cáo, và do đó lần claim, chậm thêm 30 phút.
- **Hơn 1/3 cọc phải tự lập đúng bản đó (2026-11-13).** Ngoài chữ ký >2/3 tổng cọc, chứng nhận còn cần `committedWeight` (cọc của những key đã ký **và** có cam kết giai đoạn 1 trùng đúng digest) > 1/3 tổng cọc. Node lười chỉ ký theo không thể một mình chứng nhận; mỗi key chỉ cam kết 1 lần/ngày nên một key không thể góp phần "tự lập" cho hai bản khác nhau. Khi một key bị chứng minh ký hai bản, cả chữ ký lẫn phần cam kết của nó bị trừ; bản đã chứng nhận rơi xuống ≤1/3 cam kết thì quay về chưa chứng nhận (xem mục sửa M-2 bên dưới). View mới `committedWeight(digest)`.
- **Trần chi quỹ DAO (2026-11-17).** `dao.spend` (đa số đơn giản) tối đa 5% quỹ chưa giữ chỗ mỗi kỳ 30 ngày; `dao.spendLarge` không giới hạn nhưng Governor đòi ⅔ vì không phải `spend`. CLI có thêm hành động `spendLarge`.
- **Cohort theo ngày UTC, claim nhanh (policy `Quorum.7`, 2026-11-22).** Phiên kết thúc khi cohort đóng lúc 00:00 UTC thay vì 24 giờ kể từ lúc mở; bỏ `lastSessionStart`, `SESSION_LENGTH`, `WORK_WINDOW`. Cam kết 30 phút ngay sau khi đóng, review 1 giờ, nên claim mở khoảng 1,5 giờ sau 00:00 UTC thay vì ~3,5 ngày. Mốc x5 node-work là lúc cohort đóng. Trong lúc cohort còn mở, worker đọc mỗi cast mới một lần và tính sẵn tier follower cho FID có cast thật (`prewarm`, chỉ khi key có bond cho ngày đó). Cast thiếu hoặc sai giờ bị loại vĩnh viễn nên spam chỉ bị đọc một lần. Sau giờ đóng, worker chỉ đọc lại cast và ví của người đào thật, song song 8 luồng, và chạy mỗi phút trong giờ 00–01 UTC. Intake: migration `20261122_v4_utc_day_sessions.sql` đặt `ends_at` = 00:00 UTC kế tiếp. App: đếm ngược tới lúc cohort đóng, nút claim gộp các ngày trước (`claimMany`) trong khi đang đào ngày mới. Một key tự nắm hơn ⅔ tổng cọc (ví dụ khi mạng chỉ có một node) được chứng nhận mà không cần cam kết (`soloSigned`): không ai bỏ phiếu thắng được nó nên cam kết độc lập không thêm an toàn gì. Nhờ vậy node duy nhất lỡ khung 30 phút vẫn ký muộn được, ngày không mất, chỉ claim mở trễ hơn; worker tự làm việc này. Node đó tự quyết báo cáo hằng ngày, nhưng không đụng được nguồn cung, emission, quỹ hay governance. Worker cũng tự gọi `activateNode` cho key của mình ngay khi hết 7 ngày chờ, nên không cần ai canh giờ kích hoạt. Cái giá còn lại: review 1 giờ chỉ đủ cho bot canh gác.
- **Governance và quỹ trong miniapp (2026-11-22).** Governor có thêm `proposalCount()`/`proposalAt(i)` (id + block tạo) để app liệt kê đề xuất mà không quét log; chi tiết (hành động, mô tả) đọc từ event `ProposalCreated` trong đúng block đó. Tab DAO có thêm: thẻ Quỹ (số dư, phần giữ cho vote tháng, mức đa số còn được chi trong kỳ 30 ngày), danh sách 10 đề xuất mới nhất (vote thuận/chống/trắng, queue, execute), và form đề xuất chi quỹ (tự chọn `spend` hay `spendLarge` theo trần 5%, tự dùng `proposeAsNode` nếu ví vận hành node đang hoạt động mà chưa đủ 1M phiếu). Cần biến `VITE_V4_GOVERNOR_ADDRESS`; thiếu thì app ẩn phần governance. Test app chạy cả vòng: node đề xuất, staker vote, queue, chờ timelock, execute, quỹ chi đúng.
- **Sửa M-2 và L-1 của bản tự audit (2026-11-22).** Một key tự ký đôi không còn hủy được ngày: mất ngưỡng thì ngày chờ key chưa ký ký bù, chỉ hai chứng chỉ mâu thuẫn mới khóa ngày. Key đã bị slash vẫn bị trừ chữ ký ở ngày khác nó ký đôi. Test V4: 103/103, test app: 32/32.
- **Gói phân bổ vào slot session (2026-11-13).** Số token được claim và cờ đã claim giờ nằm trong slot thứ hai của `Session` (startedAt + level + amount `uint176` + claimed), bỏ mapping `allocations` riêng. Đăng một dòng chỉ cập nhật slot người đào đã trả lúc mở phiên thay vì tạo slot mới: 100 dòng từ 9.337.632 xuống 7.316.995 gas (−21,6%). Claim tốn thêm ~2k gas/ngày. View `allocations(day, wallet)` giữ nguyên dạng trả về; getter `sessions` thêm 2 trường ở cuối.
- **Thông báo báo cáo, dung sai 1 bậc tier.** Key đang bond gọi `announceReport(day, entries)` một lần mỗi ngày trong cửa sổ ký; entries chỉ nằm trong event. Worker đọc các thông báo theo thứ tự onchain và ký bản sớm nhất khớp với dữ liệu của mình (mọi trường khớp tuyệt đối, tier follower lệch tối đa 1 bậc); không có bản nào khớp thì thông báo bản của mình rồi ký. Node đề xuất được nhích tier lệch 1 bậc mà không bị coi là gian lận. Chưa giải quyết: cast bị xóa hoặc ví bị gỡ verify giữa hai lần đọc vẫn có thể làm node lệch nhau (cần đọc lịch sử thêm/xóa của Snapchain).
- **Lọc follower chống bot (policy `Quorum.5`).** Tier follower chốt theo tuần UTC (thứ Hai 00:00): worker chỉ đếm follow tạo trước đầu tuần ít nhất 7 ngày, và chỉ đếm follower có FID đăng ký trước đầu tuần ít nhất 30 ngày. Mỗi node đếm mỗi FID một lần mỗi tuần và lưu cache (`NODE_JOURNAL_DIR/tier-cache`), nên người đào hằng ngày tốn khoảng 1/7 số lần đọc. Rủi ro đã biết: unfollow xảy ra giữa hai lần đọc của hai node vẫn có thể làm hai node lệch nhau; cache theo tuần nới rộng khoảng thời gian đó. IdRegistry cấp FID tăng dần, nên node tìm nhị phân "FID lớn nhất đăng ký trước mốc" (khoảng 40 lần đọc `onChainEventsByFid` mỗi ngày) và mọi node ra cùng kết quả. Không dùng điểm spam của Neynar/Farcaster: đó là dữ liệu đóng, đổi liên tục, node không kiểm chứng được. Ước tính trên app vẫn dùng số follower của Neynar nên có thể lệch với số node đếm.
- Deploy 7 contract theo thứ tự token → staking → timelock → DAO → registry → distributor → governor, rồi `finalizeDistributor(distributor, timelock)`. Không có ví admin nào sau bước này.

**Rủi ro đã biết sau lần rà evm-audit (checklist governance/DoS, ghim `ffe4b67`):**
1. **Chiếm governance khi ít người bỏ phiếu (đã giảm, còn trung bình).** Đã thêm sàn quorum: thuận + trắng phải đạt max(10% phiếu, min(1% lượng đã phát hành lúc đề xuất, 50% tổng phiếu)); mọi đề xuất không phải thuần chi quỹ cần 2/3 phiếu thuận; mỗi người chỉ một đề xuất đang mở. Khi lượng stake nhỏ, một nhóm vẫn có thể thông qua nếu nắm hơn nửa tổng phiếu đang active; timelock 14 ngày là lớp phản ứng cuối.
2. **Giai đoạn đầu governance phụ thuộc người stake lớn nhất (trung bình).** Ví dev còn ~1,1M token tự do; khi ít người stake, quyết định thực tế nằm ở dev.
3. **Spam phiên onchain (trung bình, off-chain).** Mỗi phiên tốn cỡ dưới 1 cent; node phải tra Snapchain cho từng phiên. Worker đọc theo lô 50 và chỉ bị chậm; cửa sổ ký report dài 6 ngày.
4. **Đề xuất đã queue không hết hạn (thấp).** `TimelockController` không có grace period; nên execute ngay khi tới hạn.
5. **Thời lượng vote tính theo block (thấp).** 43.200/302.400 block giả định block 2 giây của Base; nếu Base đổi, DAO chỉnh lại bằng `GovernorSettings`.
6. Cử tri phải tự kiểm bytecode distributor mới trước khi vote (dùng cách so runtime của `verify-open-deployment.mjs`).

## Bộ contract và công cụ

| Thành phần | Trách nhiệm |
|---|---|
| `contracts/v4/open/TokenCastOpenV4.sol` | ERC-20, premine dev một lần, trần theo ngày/thời gian/mint trọn đời; distributor theo từng ngày, governance chỉ giao được tháng UTC tương lai |
| `contracts/v4/open/MineCastNodeRegistryV4.sol` | Cọc TOKENCAST thực, snapshot trọng số từng ngày, chờ gia nhập/rút, burn cọc khi có bằng chứng ký mâu thuẫn |
| `contracts/v4/open/MineCastRewardPolicyV4.sol` | Bảng boost cố định, node ×5, trần gốc ×100, burn-boost nhân thêm ngoài trần (tối đa ×280), trần mỗi allocation 1% pool |
| `contracts/v4/open/MineCastOpenDistributorV4.sol` | EIP-712 quorum, publication theo Merkle, kiểm tra tổng/phân bổ, claim trực tiếp, phần dư 5/95, sổ mining tháng |
| `contracts/v4/open/MineCastOpenStakingV4.sol` | Stake khóa 30 ngày, snapshot thưởng cố định đầu kỳ, vote power đã trưởng thành, pool thưởng riêng tiền gốc |
| `contracts/v4/open/MineCastOpenDaoV4.sol` | Tháng lẻ air/tháng chẵn burn, Yes/No theo mature stake, giữ riêng ngân sách round; chỉ timelock governance chi được phần chưa giữ |
| `contracts/v4/open/MineCastGovernorV4.sol` + OZ `TimelockController` | Đề xuất bởi node active hoặc ≥1M stake, quorum 10%, timelock 14 ngày |
| `research/v4/open-report.mjs` | Dựng report, allocation, proof và typed data để node ký; **không** tự xác thực Farcaster |
| `research/v4/node/open-worker.mjs` | Worker quorum: đọc phiên onchain, đối chiếu với Snapchain của chính operator, tính ×5 theo luật onchain, ký mỗi ngày đúng một digest (journal tạo độc quyền + fsync trước khi chữ ký rời process; trước khi ký đối chiếu pool với `TokenCastOpenV4.dailyEmissionForDay` và digest với `reportDigest` onchain), nộp chữ ký, publish allocation, activate. Chạy định kỳ; env ghi ở đầu file. không cần backend intake |
| `research/v4/package-open.mjs` | ABI, bytecode, compiler standard input đầy đủ nguồn, manifest hash |
| `research/v4/prepare-open-deployment.mjs` | Tạo giao dịch deploy chưa ký theo nonce/địa chỉ đã chọn; không broadcast |
| `research/v4/verify-open-deployment.mjs` | Đọc chain, đối chiếu runtime với artifact và mọi liên kết token/staking/DAO/registry/distributor |

Không có proxy/upgrade, emergency mint, chức năng đổi lịch phát hành, đổi bảng boost, thay treasury hoặc thay distributor sau finalization. DAO chỉ có hai hành động cố định; không tự sửa code hay bổ nhiệm backend. Việc chọn distributor ban đầu vẫn là trách nhiệm bootstrap admin: kiểm tra `token()` không chứng minh distributor an toàn. Phải kiểm tra cả runtime/binding trước giao dịch khóa vĩnh viễn.

## Tokenomics được cưỡng chế

- Tối đa mint trọn đời 21 tỷ; burn không làm trần mint tăng lại.
- 2.100.000 premine (0,01%) vào ví dev đã chọn, có thể chuyển nhượng. Không bắt buộc tự cọc hoặc cấp thanh khoản.
- Mining 20.997.900.000. Ngày 0 là 104.989.500; ngày sau giảm 0,5%. Tính số nguyên với precision `1e36`, làm tròn xuống. Không cộng bù ngày không phát hành. Cuối đường cong, ngân sách <1 wei token trở thành 0; không hứa đào vô hạn hoặc đạt chính xác 21 tỷ.
- `amount = min(pool * weight / totalWeight, pool × (1 + 0,2L) / 100)`. Không phân bổ lại phần bị chặn trần. Chỉ khi tất cả entries có tổng weight/amount khớp report mới được mở claim.
- Boost follower: dưới 10 ×1; 10 ×2; 500 ×4; 1k ×6; 2k ×10; 5k ×18; 10k ×30; 25k ×50; 50k ×75; 100k ×100. Node có `nodeWork=true` nhân 5, tổng tối đa ×100 trước burn-boost; level 9 nâng lên ×280. **2k follower + node = ×50**. Đây là trọng số, không phải reward cố định.
- Mỗi FID và ví chỉ một allocation trong một ngày. Cast hash không được dùng lại. Tính đúng của FID/ví, follower, phiên hợp lệ, chống bot, không chồng phiên và nodeWork vẫn cần quorum kiểm chứng từ nguồn.
- Phần **chưa phân bổ**: 5% sang staking, 95% sang DAO. Phần đã phân bổ nhưng chưa claim không tính vào surplus; quá hạn mining 24h thì không mint.

## Cọc và oracle

Token cọc node tách khỏi stake DAO. Mỗi signing key đăng ký một lần, cọc ít nhất 1 triệu. Chủ ví nạp cọc là operator, signing key có thể khác ví giữ tiền; key ký dùng ECDSA, không phải ERC-1271 contract wallet. Cọc không tự cấp thưởng mining; operator vẫn cần phiên hợp lệ và quorum công nhận nodeWork.

Gia nhập chờ 7 ngày, sau đó ai cũng gọi `activateNode(key)`. Có hiệu lực từ ngày kế tiếp; trước launch thì hiệu lực ngày 0. Số cọc/key không sửa được; muốn thêm/đổi key thì tạo vị thế mới và chờ lại. Operator yêu cầu exit; mất quyền từ ngày kế tiếp, rút sau 30 ngày kể từ ranh giới exit. Không có ban tùy ý hoặc phạt chỉ vì offline.

Mẫu số là **toàn bộ cọc tại đầu ngày**, kể cả node offline. Quorum là `floor(2 * total / 3) + 1 wei cọc`. Chia một khoản thành nhiều node không tăng quyền. Ngưỡng toàn mạng 1 triệu cho phép founder đơn lẻ có 100% quyền chứng nhận. Nếu founder offline giữ ít nhất 1/3 tổng cọc, các node còn lại không đạt >2/3. Một node không thể yêu cầu xóa cọc offline của người khác. Không có tự động tiếp quản bởi top holder.

Ai cũng có thể chuyển tiếp chữ ký theo lô ≤100. Domain ký khóa chain ID, distributor, version; message khóa ngày, root, weight, allocation, số leaf, source hash và policy hash. Duplicate signer không được cộng trọng số. Source hash là cam kết dữ liệu, **không phải proof nguồn đúng**.

Hai chữ ký cùng key/cùng ngày nhưng report khác nhau là bằng chứng khách quan để `proveEquivocation`. Contract burn toàn bộ cọc còn chịu trách nhiệm của key đó; không trả thưởng tố cáo. Mọi người có thể gửi evidence, không cần root thứ hai đủ quorum. Evidence trừ chữ ký của key đó khỏi chứng chỉ của ngày và khỏi cả hai report trong evidence, mỗi ngày một lần, kể cả khi key đã bị slash vì ngày khác. Nếu chứng chỉ chưa mở claim mất ngưỡng sau evidence, ngày đó quay về trạng thái chưa chứng nhận: key chưa ký có thể ký bù cùng report đó, và review 2 ngày tính lại từ lúc chứng nhận lại. Chỉ hai chứng chỉ đủ quorum mâu thuẫn mới khóa ngày. Không sửa root/revote/khôi phục ngày bị khóa; budget ngày đó không được phát hành. Evidence phải đến trước 30 ngày sau ngày bị vi phạm; slashing không hoàn tác token đã claim hoặc tái tính snapshot quá khứ.

**Không slash tự động việc khai sai follower nếu chỉ có một report:** Base không có sự thật Farcaster để phán xét. Quorum thông đồng vẫn có thể bỏ miner thật, khai follower/nodeWork sai hoặc xác nhận danh sách giả trong các trần onchain. 48 giờ review không biến dữ liệu đó thành đúng và không có nút khiếu nại tùy ý cho phép một ví khóa mạng.

## Mốc thời gian mining và claim

Gọi `L = launchTime`, ngày cohort `d` chứa phiên bắt đầu trong `[L+d*24h, L+(d+1)*24h)`.

1. Mỗi phiên có `startedAt` trong ngày đó và kết thúc khi cohort đóng lúc 00:00 UTC. Quorum xác nhận đây là phiên/cast/owner hợp lệ, kiểm tra cast và ví ngay sau khi đóng.
2. Cam kết trong **30 phút đầu sau khi cohort đóng**, chữ ký report được gửi từ phút thứ 30. Report phải đủ quorum còn hơn 1 giờ trước hạn kết quả. Worker tính sẵn tier follower của tuần trong lúc cohort còn mở, nên báo cáo xong trong vài phút sau 00:00 UTC.
3. Công bố toàn bộ allocations và proof trong các lô ≤100. Contract tự tính amount, kiểm tra Merkle, FID/ví/cast trùng, tổng weight và tổng allocation. Sau bước này quyền nhận nằm trong state/events của Base, không cần API riêng để tải proof lúc claim.
4. Chờ 1 giờ review kể từ certificate, đủ publication, không contested, gọi `activateDay` trước **8 ngày sau cuối cohort**. Ai cũng có thể gọi.
5. Miner có **7 ngày từ activateDay** để tự `claim(day)` bằng ví nhận. Chỉ chữ ký giao dịch của ví, không cần server claim signer. Hết đúng deadline là đóng.

**Cohort đóng không đồng nghĩa claim ngay.** Với certificate sớm nhất, ngày 0 mở claim khoảng `L + 1 ngày + 1,5 giờ` (khoảng 08:30–08:45 sáng giờ VN hôm sau). App phải hiển thị các trạng thái đang đào / chờ node chốt / chờ review / có thể claim / hết hạn. UI/backend hiện tại chưa dùng luồng này. Ngày bị thiếu quorum, thiếu dữ liệu hoặc contested không mở claim; không có đường admin cứu hoặc phát bù.

## Staking và DAO

Staking khóa 30 ngày từ lần nạp gần nhất; top-up reset cả vị thế và xóa quyền vote tương lai cho tới khi trưởng thành lại. Sau đủ hạn, gọi `activateGovernancePower()` trước lúc mở round. Vote dùng checkpoint block trước giao dịch mở round; withdraw/chuyển/stake lại không tạo thêm quyền trong round cũ. Có thể rút tiền gốc đã đủ hạn mà không chờ vote kết thúc.

Reward staking chia theo số token ở timestamp **ngay trước ranh giới epoch 30 ngày**, không theo thời gian stake trung bình. Gọi snapshot trễ vẫn lấy cùng timestamp. Có thể rút sau snapshot mà vẫn có phần thưởng snapshot đó; đây là policy của bản này. Funding luôn sang epoch kế tiếp. `finalizeEpoch` theo thứ tự và tự snapshot lịch sử; không cần gọi đúng ngày đầu. Epoch không có stake chuyển reward sang kỳ sau. Claim staking 90 ngày; quá hạn chuyển phần chưa nhận bằng `sweepUnclaimed`. `rewardLiability` theo dõi nghĩa vụ thưởng riêng với `totalStaked`; không lấy tiền gốc trả thưởng. Token chuyển thẳng ngoài `fundFutureRewards` không tự được hạch toán thưởng.

Mining ledger chỉ ghi số thực claim, phân tháng UTC theo **ngày cohort bắt đầu**, không theo ngày bấm claim. `finalizeMonth(nextMonthStart)` gọi sau mốc 00:00 ngày đầu tháng kế +10 ngày. Sau đó ledger tháng bất biến; ngày mất quorum không chặn chốt tháng.

DAO mở một round/tháng trong ngày 8–21 UTC, nhưng do chốt tháng nên sớm nhất thực tế là **ngày 11**. Không còn lịch 1 và 15 cũ. Tháng lẻ airdrop, tháng chẵn burn. Vote 7 ngày, Yes>No thắng; không quorum turnout; hòa/0–0 thất bại. Thắng chờ thêm 72h rồi ai cũng settle. Airdrop budget tối đa 10% mining thực claim tháng trước; burn tối đa 5% cùng cơ sở, cả hai còn bị chặn bởi treasury khả dụng. Airdrop theo tỷ lệ mining thực claim; nhận trong 90 ngày, không phải 24h của mining. Ngân sách round được giữ riêng. Bỏ lỡ mở round thì tháng đó không có vote; treasury vẫn nằm trong contract.

## Build, kiểm thử và hiện trạng

Khóa Solidity **0.8.38+commit.1835d247**, optimizer 200, EVM Cancun, OpenZeppelin **5.6.1**. Giữ package-lock; compiler script từ chối phiên bản khác và runtime >24.576 byte. Dùng các mẫu checkpoint, CEI và giới hạn vòng lặp như [OpenZeppelin Checkpoints](https://docs.openzeppelin.com/contracts/5.x/api/utils#Checkpoints) và [Solidity security considerations](https://docs.soliditylang.org/en/latest/security-considerations.html). Đây không phải chứng nhận an toàn từ các nguồn đó.

Kết quả lần chạy 2026-11-13 (sau điều kiện >1/3 cọc tự cam kết): **99/99 tests V4 pass** và **30/30 tests app**. Kết quả lần chạy 2026-11-11: **92/92 tests V4 pass** (31 trong `open-protocol` + worker, gồm phiên onchain, ×5 onchain, ejection, governance end-to-end) và **29/29 tests app** (kèm tích hợp app với contract thật trên Anvil); `tsc` sạch. Lần trước (2026-11-09): **85/85 tests pass**, gồm 23 scenario Open V4 trên Anvil, hồi quy Nitro, Uniswap V2 local và mô hình số học/nguồn. Có 160 đối chiếu boost trong EVM, chặn replay/quorum/claim, minh chứng double-sign, principal/reward solvency, mature vote snapshot, chốt tháng, air/burn, thực thi kế hoạch deploy và kiểm tra bytecode. Batch 100 miner dùng **8.819.538 gas trên Anvil**, không phải báo giá phí Base. Chưa benchmark public testnet hay 10k miner thực. Compiler có cảnh báo tên identifier tương lai ở thư viện OZ, không có lỗi compile.

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
