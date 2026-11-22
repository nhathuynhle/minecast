# Tự rà soát bảo mật Open V4 (2026-11-13)

> **Đây không phải audit độc lập.** Người rà cũng là người viết phần lớn code, nên vẫn có điểm mù. Báo cáo này dùng để sửa lỗi trước và làm tài liệu đầu vào cho auditor bên ngoài, không thay được audit trước mainnet.

## Phạm vi và cách làm

- **Contract** (`contracts/v4/open/`, khoảng 1.060 dòng code không tính comment):
  - `TokenCastOpenV4`, `MineCastOpenDistributorV4`, `MineCastNodeRegistryV4`;
  - `MineCastOpenStakingV4`, `MineCastOpenDaoV4`, `MineCastGovernorV4`;
  - `MineCastRewardPolicyV4`.
- **Offchain có ảnh hưởng tới an toàn:**
  - `research/v4/node/open-worker.mjs`: thu thập dữ liệu, cam kết, chọn bản công bố;
  - script deploy và verify.
- **Checklist:** `austintgriffith/evm-audit-skills` bản `ffe4b670`, 8 nhóm: general, precision-math, erc20, staking, governance, signatures, dos, access-control.
- **Kiểm chứng:**
  - phát hiện nào kiểm được bằng code thì có PoC chạy trên Anvil với chính contract và worker;
  - phần kinh tế tính bằng đúng công thức onchain qua `buildOpenReport`.
- **Chưa làm:**
  - fuzz/invariant test, Slither (không cài được vì mạng bị chặn);
  - rà sâu thư viện OpenZeppelin và `MineCastCalendar`;
  - rà frontend.

## Tóm tắt

| # | Mức | Vấn đề | Loại |
|---|---|---|---|
| H-1 | Cao | Hai node lệch nhau một bậc follower (hoặc một node xấu công bố trước) là cả ngày không chứng nhận được | Lỗi code (worker + luật ⅓ cam kết) |
| H-2 | Cao | Khi dưới ~100 người đào, trần 1%/ví làm follower và ×5 mất tác dụng; FID 0 follower vẫn nhận ~1 triệu token/ngày | Thiết kế kinh tế |
| H-3 | Cao → **đã giảm** | Quỹ DAO nhận phần lớn emission giai đoạn đầu, chi tiêu chỉ cần đa số đơn giản | Thiết kế governance |
| M-1 | Trung bình | Spam phiên đào làm node không kịp thu thập trong 6 giờ cam kết | Liveness / DoS |
| M-2 | Trung bình | Một node tự ký hai bản (mất 1 triệu cọc) có thể hủy vĩnh viễn một ngày đã chứng nhận | Griefing |
| L-1 | Thấp | Key đã bị slash một lần thì bằng chứng ký đôi ở ngày khác bị revert, chữ ký của nó vẫn được tính | Lỗi code |
| L-2 | Thấp | Vote airdrop/burn hằng tháng không có quorum | Thiết kế |
| L-3 | Thấp | Thời gian vote tính theo số block nên phụ thuộc block time của Base | Cấu hình |
| I-1 … I-4 | Thông tin | Xem cuối báo cáo | |

---

## H-1. Bản công bố sớm nhất được chấp nhận nhưng không bao giờ đạt ⅓ cam kết

**Vị trí:**
- `open-worker.mjs`: `pickAnnouncement` (dòng 156), giai đoạn 2 của `processDay` (dòng 242).
- `MineCastOpenDistributorV4._certify` (dòng 254).

**Cơ chế:** ở giai đoạn 2, worker co-sign **bản công bố sớm nhất** nằm trong dung sai ±1 bậc follower, kể cả khi bản đó khác bản chính nó đã cam kết. Từ hôm nay, contract đòi cọc của những người ký **đã cam kết đúng digest đó** phải vượt ⅓ tổng cọc. Người co-sign theo bản khác không được tính vào phần này. Worker chỉ ký một lần mỗi ngày (ghi vào journal, ký bản thứ hai là bị slash), nên sau đó không quay lại ký bản của mình được nữa.

**PoC (đã chạy, Anvil):**
1. 3 node cọc bằng nhau. Node A thấy alice 2.000 follower, B và C thấy 1.000 (lệch một bậc, đúng loại lệch mà dung sai sinh ra để xử lý).
2. Cả ba cam kết bản của mình ở giai đoạn 1.
3. Ở giai đoạn 2, A chạy trước nên công bố bản của A. B và C chấp nhận bản đó và ký.

Kết quả:
- Bản của A: ký 3.000.000, cam kết 1.000.000, `certifiedAt = 0`.
- Bản B/C (giống nhau, ⅔ cọc đã cam kết): **0 chữ ký**.
- Ngày đó không chứng nhận được và mất toàn bộ emission của ngày.

**Phiên bản tấn công:** chỉ cần **một** key bất kỳ đã bond.
1. Ở giai đoạn 1, nó cam kết một bản lệch một bậc.
2. Đầu giai đoạn 2, nó công bố trước. Nó cũng có thể log entries khác hẳn report đã cam kết, vì contract không kiểm entries.
3. Mọi node trung thực chấp nhận bản này và ngày chết.

Kẻ tấn công không bị slash, vì nó chỉ ký một bản. Nó cũng không bị đẩy ra theo luật "outvoted", vì không ngày nào được chứng nhận. Đường duy nhất để loại nó là `ejectByGovernance`: vote hơn 1 tuần cộng timelock 14 ngày, tức khoảng 3 tuần mất emission.

**Cách sửa (đề xuất):** worker chọn bản có **cọc cam kết lớn nhất** thay vì bản sớm nhất.
- Với mỗi bản công bố trong dung sai, dựng lại digest từ entries, rồi cộng cọc của mọi key có `commitments[day][key] == keccak256(abi.encode(digest, key))`. Tính được vì cam kết công khai onchain.
- Ưu tiên bản của chính mình khi bằng nhau. Nếu bản của mình chưa ai công bố và có cọc cam kết lớn nhất thì tự công bố.
- Thêm event `ReportCommitted(day, key)` trong `commitReport` để worker liệt kê được các key đã cam kết (registry không có danh sách key).

**Rủi ro còn lại sau khi sửa:** nếu cả ba node cùng lệch nhau, không bản nào đạt hơn ⅓ cam kết và ngày vẫn mất. Đây là đánh đổi của luật ⅓ cam kết.

## H-2. Trần 1%/ví khiến follower và ×5 không còn tác dụng khi ít người đào

**Vị trí:** `MineCastRewardPolicyV4.allocation` (dòng 24–28) và luật thu nhận của worker (`collect`, `provable`). Không có điều kiện tối thiểu nào cho FID đào: tài khoản 0 follower vẫn có weight 5.

**Tính bằng công thức onchain, pool ngày 0 = 104.989.500 token:**

| Người đào | Mỗi ví thật (2k follower) | Mỗi FID sybil (0 follower) | Phần của cả nhóm sybil | Phần dư sang DAO/staking |
|---|---|---|---|---|
| 20 thật | 1.049.895 | — | — | 80% |
| 20 thật + 20 sybil | 1.049.895 | 477.225 | 9% | 70% |
| 20 thật + 100 sybil | 1.049.895 | 349.965 | 33% | 46% |
| 5 thật + 50 sybil | 1.049.895 | **1.049.895** (bằng người thật) | **50%** | 45% |

Khi tổng weight còn nhỏ, ai cũng chạm trần 1% bất kể follower. ×5 của node cũng vô nghĩa vì chỉ tăng weight trong khi phần thưởng đã bị chặn ở trần. Mỗi FID sybil chỉ cần một ví verify, một cast mỗi ngày và khoảng $0,003 gas.

**Cách sửa (chọn một):**
- **Trong contract:** dùng mẫu số tối thiểu, `amount = pool × weight / max(totalWeight, W_MIN)`. Ví dụ W_MIN = 5.000 (tương đương 100 ví hạng 2k): sybil weight 5 chỉ còn 0,1% pool, ví 2k follower vẫn được 1%. Phần dư đi theo đường surplus hiện có.
- **Trong luật node** (cần đổi chuỗi policy): chỉ nhận FID đăng ký đủ 30 ngày và có ít nhất 10 follower đủ tuổi.

## H-3. Quỹ DAO lớn nhưng chi tiêu chỉ cần đa số đơn giản

**Vị trí:**
- `activateDay`: 95% phần dư vào DAO (dòng 327–328).
- `MineCastGovernorV4._propose`: proposal chỉ gồm `dao.spend` không cần ⅔ (dòng 68).
- `MineCastOpenDaoV4.spend`: không có trần (dòng 156).

**Quy mô:** với 20 người đào, khoảng 76% pool mỗi ngày (~80 triệu token) vào DAO, tức khoảng 2,3 tỷ token trong tháng đầu. Đó là phần lớn lượng lưu hành lúc đó.

**Đường tấn công:**
- Giai đoạn đầu ít người stake, nên quorum = min(1% lượng đã phát hành, 50% phiếu) thực tế là 50% phiếu.
- Một người đào lớn (mỗi ngày nhận ~1 triệu token) stake 30 ngày để có quyền vote. Nếu nắm hơn nửa quyền vote đang hoạt động, họ đề xuất `spend` toàn bộ quỹ cho mình.
- Khi stake đã lớn hơn, quorum chỉ còn 10% phiếu: người nắm 10% thắng nếu không ai chủ động vote chống.
- Timelock 14 ngày chỉ cho người khác thời gian bán ra, không chặn được.

**Cách sửa:**
- Giới hạn mỗi proposal (hoặc mỗi 30 ngày) chi tối đa vài % quỹ, trên mức đó thì cần ⅔.

**Trạng thái (2026-11-17): đã sửa một phần.** `spend` (đa số đơn giản) chỉ chi được tối đa 5% quỹ chưa giữ chỗ trong mỗi kỳ 30 ngày (`SPEND_CAP_BPS`, `spentInPeriod`). Chi nhiều hơn, kể cả chuyển cả quỹ sang DAO mới, phải dùng `spendLarge`, và Governor tự xếp nó vào loại cần ⅔. Còn lại: ai nắm ⅔ số phiếu đã vote (hoặc chỉ cần đủ quorum khi không ai vote chống) vẫn chi được không giới hạn; đa số đơn giản vẫn rút được 5%/tháng.
- Hoặc gửi phần dư đi chỗ khác thay vì dồn vào DAO: đốt, hoặc chuyển sang staking.

## M-1. Spam phiên đào làm node không kịp thu thập

**Vị trí:**
- `processDay` chỉ bắt đầu `collect` khi giai đoạn cam kết mở (`open`, dòng 222). Cửa sổ chỉ có 6 giờ.
- `collect` gọi Snapchain **tuần tự** cho từng phiên (dòng 98, `provable`).

**Cơ chế:** ai cũng mở được phiên onchain với FID và hash tùy ý. Mỗi phiên tốn kẻ tấn công khoảng 136.660 gas. Ở 0,005 gwei và ETH $2.100, 100.000 phiên tốn khoảng $145 gas, cộng tiền nạp ETH cho 100.000 ví.

Gói Free của Neynar giới hạn 600 request/phút cho mỗi endpoint. Dù chạy song song hết mức, 6 giờ cũng chỉ xử lý được khoảng 216.000 phiên. Code tuần tự hiện tại xử lý ít hơn nhiều. Node không cam kết kịp thì không bản nào đạt ⅓ cam kết, và ngày mất.

**Cách sửa:**
- Bắt đầu thu thập từ `dayEnd(day)`, khi danh sách phiên đã chốt. Việc này nới cửa sổ lên khoảng 36 giờ.
- Lưu kết quả `provable` theo từng phiên.
- Chạy song song tới sát giới hạn rate.
- Nếu vẫn cần thì thêm phí mở phiên onchain nhỏ.

## M-2. Một key tự ký đôi hủy vĩnh viễn một ngày đã chứng nhận

**Vị trí:** `proveEquivocation` (dòng 369–384).

**Cơ chế:**
- Bằng chứng ký đôi trừ chữ ký (và phần cam kết) của key khỏi chứng nhận. Nếu tụt dưới ⅔ chữ ký hoặc tối đa ⅓ cam kết thì `contested = true`, và cờ này **không bao giờ gỡ**.
- Một node đã ký bản thắng cố tình ký thêm một bản rác rồi tự nộp bằng chứng. Nó mất 1 triệu cọc nhưng hủy được emission ~100 triệu token của ngày, kể cả khi phần cọc trung thực còn lại vẫn đủ ký lại.
- Scenario "signatures alone cannot certify" trong `open-protocol.test.mjs` đã cho thấy cờ bật sau một lần ký đôi.

**Cách sửa:** khi chỉ có một chứng nhận, reset `certifiedAt` (cho node khác ký bù để chứng nhận lại trong cửa sổ) thay vì đánh dấu tranh chấp vĩnh viễn. Chỉ giữ `contested` cho trường hợp có hai chứng nhận xung đột.

## L-1. Đã slash một lần thì bằng chứng ở ngày khác bị revert

**Vị trí:** `MineCastNodeRegistryV4.slashEquivocation` (dòng 165) revert khi `n.slashed`. `proveEquivocation` gọi nó **trước** khi trừ chữ ký.

**Hệ quả:** key ký đôi ở ngày 5 và ngày 6. Chứng minh ngày 5 xong thì bằng chứng ngày 6 revert, nên chữ ký của nó vẫn được tính cho chứng nhận ngày 6, trái với ý đồ thiết kế.

**Cách sửa:** nếu key đã bị slash thì bỏ qua bước slash nhưng vẫn trừ chữ ký khỏi chứng nhận.

## L-2. Vote airdrop/burn hằng tháng không có quorum

`MineCastOpenDaoV4.settle`: `passed = yes > no` (dòng 115). Một staker nhỏ duy nhất vote là quyết định được việc đốt tới 5% lượng đã đào tháng trước từ quỹ, hoặc mở airdrop. Tác động có giới hạn. Nếu cần thì thêm quorum tối thiểu.

## L-3. Thời gian vote tính theo block

Governor dùng đồng hồ theo số block của staking (43.200 block = 1 ngày với block 2 giây). Nếu Base rút block time thì thời gian chờ và thời gian vote ngắn lại theo tỷ lệ. Timelock 14 ngày tính theo giây nên không bị ảnh hưởng. Governance chỉnh lại được bằng vote ⅔.

## Thông tin

- **I-1. Distributor mới có toàn quyền với các hook của registry cho những ngày nó phụ trách.**
  - Nó slash được mọi key có cọc ở những ngày đó.
  - Nó gọi được `noteCertifiedDay` nhiều lần, khiến mọi key thành "outvoted" và ai cũng đẩy ra được.
  - Đây là quyền của governance (⅔ + timelock). Node vẫn thoát được nếu rời trước `startDay` của distributor mới. Nên ghi rõ điều này trong `CONSTITUTION.md`.
- **I-2. Gọi muộn `proveCertifiedSignature` cho một ngày cũ đặt lại `certifiedMark` về số ngày hiện tại**, làm lùi việc bị đẩy ra theo luật "outvoted". Mỗi ngày chỉ dùng được một lần.
- **I-3. Natspec của `hasSigned` đang nằm trên view `allocations`** (dòng 163). Lỗi do lần sửa gộp slot vừa rồi, chỉ là comment.
- **I-4. Nạp thêm stake reset toàn bộ quyền vote về 0 trong 30 ngày.** Đã biết, ảnh hưởng UX.

## Các điểm đã kiểm và không thấy vấn đề

- **Chữ ký:**
  - EIP-712 có `chainId` và `verifyingContract` (OZ `EIP712` tự tính lại khi fork).
  - `ECDSA.recover` của OZ chặn chữ ký malleable và địa chỉ 0.
  - Struct hash mã hóa đủ 7 trường, kể cả `POLICY_HASH`.
- **Merkle:** leaf băm hai lần và gắn với chainid, contract, ngày, chỉ số và entry. Phải đăng tuần tự, nên không trùng lá và không đăng lại được.
- **Mint:**
  - Chỉ distributor của đúng ngày mới mint được, và chỉ sau khi ngày kết thúc.
  - Mint bị chặn theo ngân sách từng ngày, `releasedSupply` và `MAX_SUPPLY`.
  - Đốt token không mở lại hạn mức.
  - Gói allocation vào slot của `Session` không mở đường claim hai lần: slot chỉ được ghi trong ngày của nó, còn đăng và claim chỉ diễn ra sau ngày đó.
- **Reentrancy:** chỉ gọi tới contract nội bộ, token không có hook, claim theo CEI và có `nonReentrant`.
- **Quyền:**
  - Sau `finalizeDistributor` không còn admin.
  - Quyền của timelock (proposer/canceller là governor, executor mở, không có admin) đã được script verify kiểm.
  - Cọc rút được ngay khi hết hạn slash, không có khoảng trống giữa hai mốc.
- **Kế toán:**
  - Staking: `rewardLiability`/rollover nhất quán, quyền vote theo checkpoint block, delegation chuyển đúng phần đang hoạt động.
  - DAO: `reserved` không vượt số dư.
  - Phân bổ: tổng phải khớp `allocated`, weight phải khớp `totalWeight` thì mới mở claim.
- **Gas:** 100 dòng phân bổ dùng 7,3 triệu gas, dưới trần 16,7 triệu mỗi giao dịch.

## Đề xuất thứ tự sửa

1. **H-1** (worker chọn theo cọc cam kết + event `ReportCommitted`) cùng regression test từ PoC ở trên. Cần làm trước khi deploy, vì đây là lỗi do luật mới thêm hôm nay.
2. **M-2** và **L-1** (sửa nhỏ trong `proveEquivocation`).
3. **M-1** (thu thập sớm và song song trong worker).
4. **H-2** và **H-3** là quyết định thiết kế của chủ dự án: mẫu số tối thiểu W_MIN, trần chi tiêu DAO.
