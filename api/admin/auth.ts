import { error, issueOpsSession, json } from "../_lib/backend";

export const config = { runtime: "edge" };

export default async function handler(request: Request) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    if (typeof body?.wallet !== "string" || typeof body?.expiresAt !== "number" || typeof body?.nonce !== "string" || typeof body?.signature !== "string") {
      throw new Error("Invalid admin login request.");
    }
    const token = await issueOpsSession({ wallet: body.wallet, expiresAt: body.expiresAt, nonce: body.nonce, signature: body.signature });
    return json({ token });
  } catch (cause) {
    return error(cause);
  }
}
