import { useEffect, type ReactNode } from "react"
import { ArrowLeft } from "lucide-react"

// The long explanations live here so the working screens only show numbers and actions.
export type GuideSection = "mining" | "rewards" | "claims" | "invites" | "boost" | "network" | "staking" | "votes" | "treasury" | "token"

const TIERS: [string, string][] = [["Under 100", "×1"], ["100", "×2"], ["500", "×3"], ["1,000", "×4"], ["2,000", "×5"],
  ["5,000", "×6"], ["10,000", "×7"], ["25,000", "×8"], ["50,000", "×9"], ["100,000", "×10"]]
// floor(√accounts), up to ×10: four times the engagement doubles it.
const ENGAGEMENT: [string, string][] = [["None", "×0"], ["1", "×1"], ["4", "×2"], ["9", "×3"], ["16", "×4"], ["25", "×5"],
  ["36", "×6"], ["49", "×7"], ["64", "×8"], ["81", "×9"], ["100", "×10"]]

const CONTENTS: [GuideSection, string][] = [["mining", "Mining"], ["rewards", "Rewards"], ["claims", "Claims"], ["invites", "Invites"],
  ["boost", "Burn boost"], ["network", "Validators"], ["staking", "Staking"], ["votes", "Monthly vote"], ["treasury", "Treasury"], ["token", "Token"]]

export function V4Guide({ section, onClose }: { section: GuideSection | "top"; onClose: () => void }) {
  useEffect(() => {
    const target = section === "top" ? null : document.getElementById(`guide-${section}`)
    if (target) target.scrollIntoView({ block: "start" }); else window.scrollTo(0, 0)
  }, [section])
  const Part = ({ id, title, children }: { id: GuideSection; title: string; children: ReactNode }) =>
    <section id={`guide-${id}`} className="v4-guide-part"><h3>{title}</h3>{children}</section>
  return <article className="v4-card v4-guide">
    <button type="button" className="v4-back" onClick={onClose}><ArrowLeft size={17} />Back</button>
    <h2>MineCast whitepaper</h2>
    <p className="v4-lede">Post on Farcaster once a day, get a share of that day's new TOKENCAST. Independent nodes check the work; stakers govern the rest.</p>
    <nav className="v4-chips" aria-label="Whitepaper sections">{CONTENTS.map(([id, label]) =>
      <button key={id} type="button" onClick={() => document.getElementById(`guide-${id}`)?.scrollIntoView({ block: "start" })}>{label}</button>)}</nav>

    <Part id="mining" title="Mining">
      <p>Post a cast from MineCast to open a session in today's cohort. Each wallet gets one session per UTC day. The cast must be new: posted at most 30 minutes before the session opens, and used for one day only.</p>
      <p>Write the cast in your own words. If its first 10 letters or digits (spaces, punctuation and case ignored) repeat the start of a cast posted earlier that day, it does not count: "123456789" after "1234567890" is a copy, "1234567891011" is not.</p>
      <p>Every session ends when the cohort closes at 00:00 UTC (07:00 in Vietnam). Starting early or late earns the same: the day's pool is shared by weight, not by time.</p>
      <p>You can open the next day's session as soon as the cohort closes, even while you wait to claim.</p>
    </Part>

    <Part id="rewards" title="Rewards">
      <p>Each day has a fixed pool of new TOKENCAST that shrinks by 0.5% a day. Your share is your weight divided by the total weight of everyone who mined that day.</p>
      <p>Your base weight is your follower multiplier times your engagement multiplier. A cast nobody liked or recast earns nothing, however many followers you have.</p>
      <dl className="v4-tiers"><dt>Followers</dt><dd>Multiplier</dd>{TIERS.map(([followers, weight]) => <div key={followers}><dt>{followers}</dt><dd>{weight}</dd></div>)}</dl>
      <dl className="v4-tiers"><dt>Likes and recasts</dt><dd>Multiplier</dd>{ENGAGEMENT.map(([count, weight]) => <div key={count}><dt>{count}</dt><dd>{weight}</dd></div>)}</dl>
      <ul>
        <li>Followers count when their account is at least 30 days old and has followed you for 7 days. Tiers refresh every Monday at 00:00 UTC.</li>
        <li>Likes and recasts count once per account, from accounts at least 30 days old other than yours, up to the cohort close at 00:00 UTC. A late cast has less time to collect them.</li>
        <li>Running a node that worked the day before multiplies your weight by 3.</li>
        <li>Each counted invite adds 10%, up to ×2.</li>
        <li>Followers, engagement, node and invites together stop at ×100. Only the burn boost goes beyond, up to ×200.</li>
        <li>Until 10,000 weight units mine on a day, one unit earns at most 0.01% of the pool, so small or fake accounts cannot take large shares.</li>
        <li>One wallet takes at most 1% of a day's pool, more with the burn boost.</li>
        <li>Whatever is not shared out goes 5% to stakers and 95% to the DAO treasury.</li>
      </ul>
      <p>Nodes certify followers, engagement and node work; the contract enforces the formula. Your reward is known once the day is certified.</p>
    </Part>

    <Part id="claims" title="Claims">
      <ol className="v4-steps">
        <li>At 00:00 UTC the cohort closes.</li>
        <li>For 30 minutes each node commits to the report it built on its own.</li>
        <li>Nodes reveal and sign the report, then publish everyone's allocation onchain.</li>
        <li>The report stays in public review for 1 hour.</li>
        <li>Claims open for 7 days, usually by 01:30 UTC (08:30 in Vietnam).</li>
      </ol>
      <p>Claiming never blocks your next session. You can read or claim any day straight from Base, even when the MineCast server is offline.</p>
    </Part>

    <Part id="invites" title="Invites">
      <p>Share your invite link. When a friend opens their first session from it, you are recorded as their inviter, once and for good.</p>
      <p>The invite counts the first time one of their rewarded days shows 100 or more followers. Each Farcaster account counts once. Every counted invite adds 10% to sessions you open afterwards, up to 10 invites.</p>
    </Part>

    <Part id="boost" title="Burn boost">
      <p>Each level burns 1,000,000 TOKENCAST forever and adds 20% to your weight and to your daily cap. There are 9 levels; level L unlocks once L × 10% of all mining has been released.</p>
      <p>A level applies to sessions opened after the burn and stays with your wallet.</p>
    </Part>

    <Part id="network" title="Validators">
      <p>Nodes bond at least 1,000,000 TOKENCAST and sign each day's report. A report needs signatures from more than two thirds of all bonded stake; offline stake still counts against it. A node's voting power is its bond, so more power always puts more tokens at risk.</p>
      <p>New nodes wait 7 days before they count. A node that stays silent for more than two weeks can be removed, and its bond returns after 30 days. If over half of the bond agrees on a report but cannot reach two thirds, any node off that report for 3 days in a row is removed the same way, so blocking the network takes more bond than the majority. Signing two different reports for one day burns the bond.</p>
      <p>While one operator holds more than two thirds of the bond, that operator alone decides each day's report, within the caps. Anyone can check a certified day against Farcaster with <code>research/v4/node/check-day.mjs</code>.</p>
      <h4>Run a node</h4>
      <ol className="v4-steps">
        <li>Get a Linux server with Node.js 22 and a Snapchain source: your own Snapchain node, or a hosted Snapchain API.</li>
        <li>Clone the MineCast repository on the server and create a new signing key for the node. Never use a wallet you hold funds in: this key only signs reports and pays gas, so send it a little ETH on Base.</li>
        <li>Put <code>V4_CHAIN_ID</code>, <code>V4_RPC_URL</code>, <code>V4_DISTRIBUTOR_ADDRESS</code>, <code>NODE_SIGNING_KEY</code>, <code>NODE_JOURNAL_DIR</code> and <code>SNAPCHAIN_URL</code> in a file only you can read. Run <code>research/v4/node/open-worker.mjs</code> with it from cron: every 10 minutes, and every minute from 00:00 to 01:59 UTC.</li>
        <li>From the wallet that will operate the node, approve the node registry to take your bond on the TOKENCAST contract, then call <code>registerNode</code> with the signing key's address and the amount (1,000,000 TOKENCAST is 1000000 followed by 18 zeros), for example on the registry's Basescan page. To earn the ×5 node bonus, operate it from the wallet you mine with.</li>
        <li>After 7 days the worker activates the key by itself. It counts from the next UTC day.</li>
      </ol>
      <ul>
        <li>More power: register another key with more bond and run a second worker with it.</li>
        <li>Lost or leaked server key: call <code>rotateKey</code> from the operator wallet. The new key takes over the same bond from tomorrow's report; the old key still counts for today's. Anything the old key ever signed twice can still burn the bond.</li>
        <li>Leaving: call <code>requestExit</code>. The bond can be withdrawn 30 days after the last day the key counted.</li>
      </ul>
    </Part>

    <Part id="staking" title="Staking">
      <p>Staked TOKENCAST is locked for 30 days, and every top-up locks the whole stake again. Staked tokens become voting power by themselves once they are 30 days old; a top-up never removes power you already have, and withdrawing removes it at once. Changing your delegate needs an unlocked stake, locks it again for 30 days, and the new voter gains the power after those 30 days.</p>
      <p>Stakers share 5% of each day's unshared pool, paid per 30-day epoch to stake held through the whole epoch. Each epoch's rewards can be claimed for 90 days.</p>
    </Part>

    <Part id="votes" title="Monthly vote">
      <p>Odd months vote on an airdrop of 10% of last month's mining to miners who had at least a third of what they mined staked by the end of the 16th (UTC). Even months vote on burning 5% of it from the treasury.</p>
      <p>A round opens once the previous month is closed, between the 17th and the 28th (UTC). Voting lasts 7 days, Yes must beat No, and a passing result waits 72 hours.</p>
    </Part>

    <Part id="treasury" title="Treasury">
      <p>No one holds a key to the treasury. Stakers vote on every spend. A simple majority may spend up to 5% of the unreserved balance, a credit that refills over 30 days. Anything larger needs two thirds and draws on a credit of 20% that refills over 90 days, so no vote can empty the treasury at once. A spend not executed within two weeks of the earliest moment it could run expires.</p>
      <p>Every passed proposal waits 14 days in a timelock before anyone can execute it. Proposing needs 1,000,000 TOKENCAST of voting power or an active node, and one live proposal per wallet.</p>
    </Part>

    <Part id="token" title="Token">
      <p>TOKENCAST has a lifetime maximum of 21,000,000,000 and a developer premine of 2,100,000. Burns lower the supply and never restore the mint limit.</p>
    </Part>
  </article>
}
