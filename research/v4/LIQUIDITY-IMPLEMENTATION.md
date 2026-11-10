# V4: premine dev và thanh khoản tùy chọn sau mining

Ngày 2026-11-08. Quyết định hiện hành: **mint một lần 2.100.000 TOKENCAST (0,01%) vào ví dev khi deploy token**. Thay thế hoàn toàn phương án 210 triệu thanh khoản khởi động. Mining không phải chờ tạo pool; dev có thể dùng token đang sở hữu hoặc đã claim, ghép ETH trên Base để thêm thanh khoản sau. [Ngân sách và điều kiện bootstrap](./node/DEV-BOOTSTRAP.md).

Đây là Solidity thử nghiệm local, chưa audit độc lập, chưa deploy hoặc tạo pool trên mạng công khai. Mini app/token testnet hiện hành chưa được chuyển sang bộ này.

## Contract và quyền

| File | Chức năng |
|---|---|
| `contracts/v4/open/TokenCastOpenV4.sol` | ERC-20, 21 tỷ lifetime, premine dev 2,1 triệu; mining 20.997.900.000, giảm 0,5%/ngày |
| `contracts/v4/liquidity/MineCastLiquidityLockerV4.sol` | Nhận TOKENCAST của chính người gọi và ETH; thêm thanh khoản V2 và khóa LP mới vĩnh viễn |
| `contracts/v4/liquidity/PermanentLiquidityLockV4.sol` | Giữ LP; chỉ có getter `lpToken()` và `lockedBalance()` |
| `research/v4/liquidity.test.mjs` | Kiểm thử EVM bằng factory/pair chính thức `@uniswap/v2-core@1.0.1` |

Token nhận `(devWallet, bootstrapAdmin, launchTime)` ở constructor; ví phải khác zero, thời điểm mining nằm trong tương lai. Không hardcode ví dev từ địa chỉ testnet cũ. Constructor mint 2,1 triệu một lần vào `devWallet` và ghi vào `cumulativeMinted`. Không có quyền mint thêm premine, tăng tổng cung hoặc thay ví nhận sau deploy. Burn giảm circulating supply, không hoàn lại hạn mức mint trọn đời.

Dev sở hữu token này bình thường: có thể chuyển, bán, cọc hoặc cấp thanh khoản. **Token không bắt buộc dev chạy node hay thêm thanh khoản sau này.** Không gọi đây là zero-premine hoặc toàn bộ cung đã phân tán cho cộng đồng.

`bootstrapAdmin` chọn distributor một lần qua `finalizeDistributor`, rồi bị xóa. Không cần pool trước khi nối distributor. Đây còn là điểm tin cậy: kiểm tra `token()` chỉ xác nhận binding, không chứng minh distributor an toàn. Distributor sai có thể phân phối sai trong trần; token chỉ thực thi ngày đã kết thúc, trần từng ngày, trần lịch và tổng mint trọn đời. Cap 1% theo miner, bonus, proof, stake và DAO cần logic riêng.

## Thêm thanh khoản sau

Helper nhận `(token, factory, weth, pairRuntimeCodeHash)` ở constructor. Lấy hoặc tạo pair TOKENCAST/WETH và tạo locker riêng. Không có funder/admin; ai cũng được thêm **token của chính mình**, bất kỳ lúc nào, gồm cả pool đã có giao dịch. Helper không có quyền mint token.

Luồng mỗi lần thêm:

`approve lượng TOKENCAST cần dùng -> addLiquidityAndLock kèm ETH -> đồng bộ reserves -> tính hai lượng dùng -> chuyển token từ caller -> wrap ETH cần dùng -> pair.mint(locker) -> kiểm tra số dư/LP -> hoàn ETH dư`

Mỗi lần thêm khóa toàn bộ LP mới nhận thẳng vào locker trong cùng giao dịch. Nếu bước nào lỗi, toàn bộ lần thêm đó revert, bao gồm chuyển token, tiêu allowance, wrap, mint LP và hoàn tiền; gas vẫn bị tính. Token và số dư tồn tại trước giao dịch không bị xóa khi lần thêm thất bại. Chỉ approve helper đã xác minh, với lượng dự định cấp pool; không gửi tài sản trực tiếp vào helper/locker.

`addLiquidityAndLock` nhận một tuple:

| Tham số | Ý nghĩa |
|---|---|
| `tokenDesired` | Số TOKENCAST tối đa lấy từ ví gọi, đơn vị wei token |
| `tokenMin` | Số token tối thiểu chấp nhận dùng, > 0 |
| `ethMin` | Số ETH tối thiểu chấp nhận dùng, đơn vị wei, > 0 |
| `minLiquidity` | Số đơn vị LP tối thiểu nhận trong locker, > 0 |
| `deadline` | Unix timestamp hết hạn giao dịch |
| `maxInitialTokenReserve` | Trần tổng TOKENCAST sau nạp khi pool chưa có LP, gồm cả donation |
| `maxInitialWethReserve` | Trần tổng WETH sau nạp khi pool chưa có LP, gồm cả donation |

`msg.value` là lượng ETH tối đa cấp. Pool đã có LP dùng tỷ lệ reserves để chọn lượng phù hợp: token không dùng nằm lại trong ví, ETH không dùng được hoàn ngay. Hai trần initial chỉ áp dụng khi tổng LP bằng 0. Chọn minima theo báo giá trước khi ký và mức trượt giá thực sự chấp nhận; đặt gần zero làm mất bảo vệ trước thay đổi tỷ lệ. Tỷ lệ spot của pool không phải oracle giá an toàn.

Pool mới dùng toàn bộ `tokenDesired` và ETH gửi. Với pool trống, LP nhận là `floor(sqrt(tokenWei × ethWei)) - MINIMUM_LIQUIDITY`; dùng số nguyên. Pair chuẩn còn mint 1.000 đơn vị LP nhỏ nhất vào zero. Pair tạo trước và token/WETH được tặng được kiểm tra theo trần đã ký; không tự mở rộng trần. Donation không tạo LP cho người tặng. Nếu bị chặn do donation, phải xem lại số dư và giới hạn, không tự bỏ kiểm tra.

## LP khóa nghĩa là gì

- Locker không có owner, proxy, withdraw, approve, rescue, execute, ngày mở khóa hay quyền DAO lấy LP. Helper cũng không có đường rút LP từ locker.
- Khóa áp dụng cho LP tạo qua helper. Người khác vẫn swap, thêm/rút LP riêng. Lượng hai tài sản, tỷ lệ nắm giữ pool và giá có thể thay đổi; khóa LP không bảo đảm giá hoặc ngăn người sở hữu token bán.
- Phí swap tích lũy cho phần LP khóa ở lại pool, dev không có hàm thu riêng phần phí này. Protocol fee của factory là cơ chế riêng, không bị locker kiểm soát.
- Nếu dev dùng router/DEX khác và giữ LP trong ví, phần đó **không tự khóa** theo thiết kế này.

## Dependency và phạm vi

Chỉ hỗ trợ giao diện Uniswap V2 toàn dải giá, không nhận NFT V3/V4. Helper chuyển tài sản thẳng vào pair, không cấp allowance cho router. `pairRuntimeCodeHash` là keccak256 runtime bytecode, không phải init-code hash CREATE2. Phải kiểm tra factory, WETH, pair code/hash và quyền quản trị trên đúng chain; hash pair không chứng minh factory/WETH đáng tin. Chưa chọn cấu hình Base hoặc lượng ETH thật.

Không có rescue cho tài sản gửi nhầm. ETH hoàn được tính đúng bằng `msg.value - ethUsed`, không lấy ETH cũ gửi nhầm trả cho caller. Receiver không nhận được ETH hoàn thì cả lần thêm revert. Kiểm thử dùng WETH giả có chế độ gây lỗi; các fixture không phải contract deploy thật.

`TokenCastOpenV4` khớp `node/bootstrap-model.mjs`: ngày 0 có 104.989.500, ngày 1 có 104.464.552,5, ngày 2 có 103.942.229,7375 TOKENCAST. Ngày bỏ lỡ không cộng vào pool ngày sau. Token cho phép distributor issue vào ngân sách ngày cũ; deadline claim/kết quả phải do distributor thực thi.

`TokenCastV4.sol`, `emission.mjs`, `snapshot.mjs` và distributor Nitro cũ còn dùng zero-premine, ngày đầu 105 triệu. Không tráo địa chỉ token để coi hai bộ tương thích. Open Node chưa có registry, source verifier, reward proof và distributor hoàn chỉnh. Test phát hành dùng distributor giả **không kiểm tra mining/Farcaster**, để cô lập các bất biến của token.

## Kiểm tra local

Dependencies khóa bằng package-lock; Anvil trên PATH hoặc `ANVIL_BIN`. Test dùng chain local 31337, tài khoản giả, tự đóng node, không đọc khóa thật.

```powershell
Set-Location 'C:\Users\nhath\.gemini\antigravity\scratch\minecast-clean'
$env:ANVIL_BIN = 'C:\Users\nhath\AppData\Local\Temp\minecast-v4-evm-tests\node_modules\@foundry-rs\anvil-win32-amd64\bin\anvil.exe'
node --test research/v4/liquidity.test.mjs research/v4/node/bootstrap-model.test.mjs research/v4/node/quorum-model.test.mjs
```

Kiểm tra premine, quyền mint, mining trước DEX, thêm thanh khoản từ token đã phát hành, minima/allowance/deadline, rollback, donation, pool đã hoạt động, hoàn ETH, callback, khóa LP sau 100 năm, swap, LP của người khác/protocol fee, burn và lịch phát hành đối chiếu mô hình. 1 ETH và 500.000 token trong fixture chỉ là số liệu test. Chưa fork-test Base hoặc audit độc lập.

Nguồn: [Uniswap V2 core](https://github.com/Uniswap/v2-core), [deployment chính thức](https://developers.uniswap.org/docs/protocols/v2/deployments), [cơ chế LP](https://developers.uniswap.org/docs/protocols/v2/concepts/pools).
