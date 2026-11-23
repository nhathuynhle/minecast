import { useEffect, type ReactNode } from "react"
import { ArrowLeft } from "lucide-react"

// The long explanations live here so the working screens only show numbers and actions.
export type GuideSection = "mining" | "rewards" | "claims" | "invites" | "boost" | "network" | "staking" | "votes" | "treasury" | "token"

const TIERS: [string, string][] = [["Under 10", "×1"], ["10", "×2"], ["500", "×4"], ["1,000", "×6"], ["2,000", "×10"],
  ["5,000", "×18"], ["10,000", "×30"], ["25,000", "×50"], ["50,000", "×75"], ["100,000", "×100"]]

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
      <p>Post a cast from MineCast to open a session in today's cohort. Each wallet gets one session per UTC day.</p>
      <p>Every session ends when the cohort closes at 00:00 UTC (07:00 in Vietnam). Starting early or late earns the same: the day's pool is shared by weight, not by time.</p>
      <p>You can open the next day's session as soon as the cohort closes, even while you wait to claim.</p>
    </Part>

    <Part id="rewards" title="Rewards">
      <p>Each day has a fixed pool of new TOKENCAST that shrinks by 0.5% a day. Your share is your weight divided by the total weight of everyone who mined that day.</p>
      <dl className="v4-tiers"><dt>Followers</dt><dd>Weight</dd>{TIERS.map(([followers, weight]) => <div key={followers}><dt>{followers}</dt><dd>{weight}</dd></div>)}</dl>
      <ul>
        <li>Followers count when their account is at least 30 days old and has followed you for 7 days. Tiers refresh every Monday at 00:00 UTC.</li>
        <li>Running a node that worked the day before multiplies your weight by 5.</li>
        <li>Each counted invite adds 10%, up to ×2.</li>
        <li>Tier, node and invites together stop at ×100. Only the burn boost goes beyond, up to ×200.</li>
        <li>Until 10,000 weight units mine on a day, one unit earns at most 0.01% of the pool, so small or fake accounts cannot take large shares.</li>
        <li>One wallet takes at most 1% of a day's pool, more with the burn boost.</li>
        <li>Whatever is not shared out goes 5% to stakers and 95% to the DAO treasury.</li>
      </ul>
      <p>Nodes certify followers and node work; the contract enforces the formula. Estimates in the app use MineCast sessions only and can change until the day is certified.</p>
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
      <p>Nodes bond at least 1,000,000 TOKENCAST and sign each day's report. A report needs signatures from more than two thirds of all bonded stake; offline stake still counts against it.</p>
      <p>New nodes wait 7 days before they count. A node that stays silent for more than two weeks can be removed, and its bond returns after 30 days. Signing two different reports for one day burns the bond.</p>
    </Part>

    <Part id="staking" title="Staking">
      <p>Staked TOKENCAST is locked for 30 days, and every top-up locks the whole stake again. Activate your voting power to use it in votes.</p>
      <p>Stakers share 5% of each day's unshared pool, paid per 30-day epoch. Each epoch's rewards can be claimed for 90 days.</p>
    </Part>

    <Part id="votes" title="Monthly vote">
      <p>Odd months vote on an airdrop of 10% of last month's mining to miners who kept at least a third of what they mined staked when the round opened. Even months vote on burning 5% of it from the treasury.</p>
      <p>A round opens once the previous month is closed, between the 17th and the 28th (UTC). Voting lasts 7 days, Yes must beat No, and a passing result waits 72 hours.</p>
    </Part>

    <Part id="treasury" title="Treasury">
      <p>No one holds a key to the treasury. Stakers vote on every spend. A simple majority may spend up to 5% of the unreserved balance in each 30-day period; anything larger needs two thirds.</p>
      <p>Every passed proposal waits 14 days in a timelock before anyone can execute it. Proposing needs 1,000,000 TOKENCAST of active voting power or an active node, and one live proposal per wallet.</p>
    </Part>

    <Part id="token" title="Token">
      <p>TOKENCAST has a lifetime maximum of 21,000,000,000 and a developer premine of 2,100,000. Burns lower the supply and never restore the mint limit.</p>
    </Part>
  </article>
}
