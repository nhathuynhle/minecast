const APP_URL = "https://minecast-beta.vercel.app";

/**
 * Farcaster reads this exact URL: /.well-known/farcaster.json.
 * The Vercel rewrite keeps the account-association signature in environment
 * variables instead of committing it to the repository.
 */
export const config = { runtime: "edge" };

export default function handler() {
  const header = process.env.FARCASTER_ASSOCIATION_HEADER;
  const payload = process.env.FARCASTER_ASSOCIATION_PAYLOAD;
  const signature = process.env.FARCASTER_ASSOCIATION_SIGNATURE;

  if (!header || !payload || !signature) {
    return Response.json(
      { error: "Farcaster account association has not been configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return Response.json(
    {
      accountAssociation: { header, payload, signature },
      frame: {
        version: "1",
        name: "MineCast",
        iconUrl: `${APP_URL}/tokencast-logo.png`,
        homeUrl: APP_URL,
        splashImageUrl: `${APP_URL}/tokencast-logo.png`,
        splashBackgroundColor: "#0b0f17",
      },
    },
    {
      headers: {
        "Cache-Control": "public, max-age=300, s-maxage=300",
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  );
}
