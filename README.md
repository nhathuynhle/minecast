# ⛏️ MineCast — Farcaster Mini App

Ứng dụng đào **$TOKENCAST** (Proof of Cast) trên mạng **Base**, lấy cảm hứng từ mô hình Pi Network và Bitcoin Halving.

## 🚀 Tính năng chính

- **Cơ chế đào 8 tiếng**: Người dùng Cast trên Farcaster để kích hoạt phiên đào 8 giờ. Hết giờ phải cast tiếp để kích hoạt lại.
- **Tổng cung**: **21,000,000,000 $TOKENCAST** (21 tỷ - Hard cap, không thể mint thêm).
- **Halving chia đôi**: Càng nhiều người đào, phần thưởng mỗi phiên càng giảm (Era 0 = 8,000 token/phiên).
- **Hệ thống mời bạn bè**: 
  - Người được mời: Tăng ngay **+20%** tốc độ đào.
  - Người mời: Hưởng **8%** hoa hồng token từ mỗi phiên đào của bạn bè (tối đa 20 người).
  - Tích lũy bạn bè nhận thêm bonus tốc độ đào cho bản thân (3 bạn: +10%, 7 bạn: +20%, 15 bạn: +30%).
- **Smart Contract Base**: ERC-20 chuẩn với cơ chế claim bằng chữ ký EIP-712 (User tự trả gas Base siêu rẻ ~$0.002).

## 🛠️ Công nghệ

- React 19 + TypeScript
- Vite 6 + Tailwind CSS v4
- Farcaster Mini App SDK (`@farcaster/miniapp-sdk`)
- Solidity 0.8.24 (Base Network)
