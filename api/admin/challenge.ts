import { createOpsChallenge, error, json } from "../_lib/backend";

export const config = { runtime: "edge" };

export default async function handler(request: Request) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  try {
    const wallet = new URL(request.url).searchParams.get("wallet") ?? "";
    return json(await createOpsChallenge(wallet));
  } catch (cause) {
    return error(cause);
  }
}
