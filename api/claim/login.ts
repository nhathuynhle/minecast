import { createClaimWalletLogin, error, json, requireFarcasterUser, requireWallet } from "../_lib/backend";

export const config = { runtime: "edge" };

/** Issues a five-minute, FID-bound message that the withdrawal wallet signs for free. */
export default async function handler(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const fid = await requireFarcasterUser(request);
    const { userAddress } = await request.json();
    requireWallet(userAddress);
    return json(await createClaimWalletLogin(fid, userAddress));
  } catch (cause) { return error(cause); }
}
