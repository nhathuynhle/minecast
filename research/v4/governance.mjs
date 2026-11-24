// Stake governance from the command line. Every call goes straight to MineCastGovernorV4; no backend.
//   $env:V4_RPC_URL = "https://sepolia.base.org"; $env:V4_CHAIN_ID = "84532"
//   $env:V4_GOVERNOR_ADDRESS = "0x..."; $env:KEYSTORE = "C:\minecast-keys\me.json"   # your wallet, encrypted
//   (or $env:PRIVATE_KEY = "0x..."; keystore files come from research/v4/keystore.mjs)
//   node research/v4/governance.mjs propose proposal.json [nodeSigningKey]   # node operators pass their key
//   node research/v4/governance.mjs status|queue|execute proposal.json
//   node research/v4/governance.mjs vote proposal.json for|against|abstain
//   node research/v4/governance.mjs delegate 0xDelegate                     # lend your mature stake's votes
// proposal.json (amounts in whole tokens):
//   { "description": "Fund node servers for January",
//     "actions": [ { "spend": { "to": "0x...", "amount": "50000" } },
//                  { "spendLarge": { "to": "0x...", "amount": "900000000" } },   # above the 5%/30-day cap: needs 2/3
//                  { "scheduleDistributor": { "distributor": "0x...", "startDay": 90 } },
//                  { "call": { "target": "0x...", "signature": "function ejectByGovernance(address)", "args": ["0x..."] } } ] }
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createWalletClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, parseAbiItem, parseEther, publicActions, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base, baseSepolia } from 'viem/chains'
import { keystoreAccount } from './keystore.mjs'

const governorAbi = parseAbi([
  'function dao() view returns (address)', 'function registry() view returns (address)', 'function token() view returns (address)',
  'function hashProposal(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) pure returns (uint256)',
  'function propose(address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)',
  'function proposeAsNode(address signingKey, address[] targets, uint256[] values, bytes[] calldatas, string description) returns (uint256)',
  'function castVote(uint256 proposalId, uint8 support) returns (uint256)',
  'function state(uint256 proposalId) view returns (uint8)',
  'function proposalVotes(uint256 proposalId) view returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)',
  'function proposalQuorum(uint256 proposalId) view returns (uint256)',
  'function needsSupermajority(uint256 proposalId) view returns (bool)',
  'function proposalSnapshot(uint256 proposalId) view returns (uint256)',
  'function proposalDeadline(uint256 proposalId) view returns (uint256)',
  'function proposalEta(uint256 proposalId) view returns (uint256)',
  'function queue(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) returns (uint256)',
  'function execute(address[] targets, uint256[] values, bytes[] calldatas, bytes32 descriptionHash) payable returns (uint256)',
  'error ProposerHasLiveProposal(address proposer, uint256 proposalId)',
  'error GovernorInsufficientProposerVotes(address proposer, uint256 votes, uint256 threshold)',
  'error GovernorRestrictedProposer(address proposer)',
  'error GovernorNonexistentProposal(uint256 proposalId)',
  'error GovernorUnexpectedProposalState(uint256 proposalId, uint8 current, bytes32 expectedStates)',
  'error GovernorAlreadyCastVote(address voter)',
])
const registryAbi = parseAbi(['function token() view returns (address)'])
const stakingAbi = parseAbi(['function delegate(address delegatee)'])
const STATES = ['Pending', 'Active', 'Canceled', 'Defeated', 'Succeeded', 'Queued', 'Expired', 'Executed']
const SUPPORT = { against: 0, for: 1, abstain: 2 }

/** Turn a human-readable proposal into Governor arguments. Unknown action kinds are rejected. */
// Spends expire: 45 days covers the 1-day delay, 7-day vote and 14-day timelock with three weeks to spare.
export function buildProposal({ description, actions }, { dao, token, deadline = BigInt(Math.floor(Date.now() / 1000)) + 45n * 86_400n }) {
  if (typeof description !== 'string' || !description.trim() || !Array.isArray(actions) || !actions.length) throw Error('Need a description and at least one action')
  const calls = actions.map(action => {
    const [kind, a] = Object.entries(action)[0] ?? []
    if (kind === 'spend') return [dao, encodeFunctionData({ abi: parseAbi(['function spend(address to, uint256 amount, uint256 deadline)']),
      args: [getAddress(a.to), parseEther(String(a.amount)), deadline] })]
    // spendLarge (above the 5% credit) is not a plain spend, so the Governor needs two thirds for it.
    if (kind === 'spendLarge') return [dao, encodeFunctionData({ abi: parseAbi(['function spendLarge(address to, uint256 amount, uint256 deadline)']),
      args: [getAddress(a.to), parseEther(String(a.amount)), deadline] })]
    if (kind === 'scheduleDistributor') return [token, encodeFunctionData({ abi: parseAbi(['function scheduleDistributor(address distributor, uint256 startDay)']),
      args: [getAddress(a.distributor), BigInt(a.startDay)] })]
    if (kind === 'call') return [getAddress(a.target), encodeFunctionData({ abi: [parseAbiItem(a.signature)], args: a.args ?? [] })]
    throw Error('Unknown action: ' + kind)
  })
  return { targets: calls.map(c => c[0]), values: calls.map(() => 0n), calldatas: calls.map(c => c[1]), description,
    descriptionHash: keccak256(toHex(description)) }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const [command, arg, extra] = process.argv.slice(2)
  const env = name => { if (!process.env[name]) throw Error('Set ' + name); return process.env[name] }
  const chain = { 8453: base, 84532: baseSepolia }[Number(process.env.V4_CHAIN_ID ?? 84532)]
  if (!chain) throw Error('V4_CHAIN_ID must be 8453 or 84532')
  const account = process.env.KEYSTORE ? await keystoreAccount(process.env.KEYSTORE)
    : process.env.PRIVATE_KEY ? privateKeyToAccount(process.env.PRIVATE_KEY.trim()) : undefined
  const client = createWalletClient({ account, chain, transport: http(env('V4_RPC_URL')) }).extend(publicActions)
  if (await client.getChainId() !== chain.id) throw Error('V4_RPC_URL is on another chain')
  const governor = getAddress(env('V4_GOVERNOR_ADDRESS'))
  const read = (functionName, args, address = governor, abi = governorAbi) => client.readContract({ address, abi, functionName, args })
  async function send(functionName, args, address = governor, abi = governorAbi) {
    if (!account) throw Error('Set KEYSTORE (or PRIVATE_KEY) to send transactions')
    const hash = await client.writeContract({ address, abi, functionName, args, account })
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw Error(functionName + ' reverted: ' + hash)
    console.log(functionName + ' ok: ' + hash)
  }
  if (command === 'delegate') {
    await send('delegate', [getAddress(arg)], await read('token'), stakingAbi)
    process.exit(0)
  }
  const p = buildProposal(JSON.parse(fs.readFileSync(arg, 'utf8')), { dao: await read('dao'), token: await read('token', [], await read('registry'), registryAbi) })
  const id = await read('hashProposal', [p.targets, p.values, p.calldatas, p.descriptionHash])
  if (command === 'propose') await send(extra ? 'proposeAsNode' : 'propose', extra
    ? [getAddress(extra), p.targets, p.values, p.calldatas, p.description] : [p.targets, p.values, p.calldatas, p.description])
  else if (command === 'vote') {
    if (!(extra in SUPPORT)) throw Error('Vote for, against or abstain')
    await send('castVote', [id, SUPPORT[extra]])
  } else if (command === 'queue' || command === 'execute') await send(command, [p.targets, p.values, p.calldatas, p.descriptionHash])
  else if (command !== 'status') throw Error('Commands: propose, status, vote, queue, execute, delegate')
  const [state, [against, inFavour, abstain], supermajority, snapshot, deadline, eta] = await Promise.all(
    ['state', 'proposalVotes', 'needsSupermajority', 'proposalSnapshot', 'proposalDeadline', 'proposalEta'].map(f => read(f, [id])))
  const quorum = await read('proposalQuorum', [id]).catch(() => null) // the stake snapshot exists once voting starts
  const t = n => (Number(n / 10n ** 15n) / 1000).toLocaleString('en-US') // whole tokens, 3 decimals
  console.log(JSON.stringify({ id: id.toString(), state: STATES[state], for: t(inFavour), against: t(against), abstain: t(abstain),
    quorumNeeded: quorum === null ? 'known when voting starts' : t(quorum), rule: supermajority ? 'two thirds of for+against' : 'simple majority',
    votingStartsAfterBlock: snapshot.toString(), votingEndsAtBlock: deadline.toString(),
    executableAt: eta ? new Date(Number(eta) * 1000).toISOString() : null }, null, 2))
}
