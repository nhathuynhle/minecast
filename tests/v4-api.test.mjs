import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './v4-test-loader.mjs'

const backendMock = 'export const json = (x,s=200) => Response.json(x,{status:s});' +
  ['requireFarcasterUser','requireWallet','supabase'].map(k => 'export const '+k+'=(...a)=>globalThis.v4Backend.'+k+'(...a);').join('')
const v4Mock = ['serverV4Config','gateV4','scopeV4','sessionsV4','identityV4'].map(k => 'export const '+k+'=(...a)=>globalThis.v4Intake.'+k+'(...a);').join('') +
  'export const sessionColumns="id,fid,wallet_address,cast_hash,day,started_at,ends_at";'
const { default: handler } = await loadModule('api/v4/mining.ts', { '../_lib/backend': backendMock, '../_lib/v4': v4Mock })
const realFetch = globalThis.fetch, oldKey = process.env.NEYNAR_API_KEY
const wallet = '0x'+'1'.repeat(40), distributor = '0x'+'2'.repeat(40), castHash='0x'+'3'.repeat(40)
const deployment = { chainId: 84532, distributor }, identity = { protocol:'open-v4-quorum-1', ...deployment }
const now = 1893500000n
let cast, rows, calls, gate, inserted
beforeEach(() => {
  process.env.NEYNAR_API_KEY='test-only'
  rows=[];calls=[];inserted=0
  cast={ hash:castHash, text:'Edited with image', timestamp:new Date(Number(now)*1000).toISOString(),
    embeds:[{url:'https://example.com/a.png'}], author:{fid:42, follower_count:2000, verified_addresses:{eth_addresses:[wallet]}} }
  gate={eligible:true,reason:'Ready',network:{timestamp:now,day:0n}}
  globalThis.v4Intake={ serverV4Config:()=>deployment, identityV4:()=>identity, gateV4:async()=>gate,
    scopeV4:()=> 'chain_id=eq.84532&distributor=eq.'+distributor, sessionsV4:async()=>rows }
  globalThis.v4Backend={
    requireFarcasterUser:async request=>{if(request.headers.get('authorization')!=='Bearer test')throw Error('Farcaster authentication is required.');return 42},
    requireWallet:value=>{assert.match(value,/^0x[a-f0-9]{40}$/i);return value},
    supabase:async(path,init={})=>{
      calls.push({path,init})
      if(path==='rpc/get_v4_mining_stats') return Response.json([{observed_at:new Date().toISOString(),active_miners:'4',cohort_miners:'10',estimated_miners:'10',total_weight:'60'}])
      if(path==='rpc/start_v4_mining_session_with_estimate') {
        const p=JSON.parse(init.body);inserted++
        const row={id:'id1',fid:p.p_fid,wallet_address:p.p_wallet,cast_hash:p.p_cast_hash,day:p.p_day,
          started_at:p.p_started_at,ends_at:new Date(Date.parse(p.p_started_at)+86400000).toISOString()}
        rows.push(row);return Response.json([row])
      }
      return Response.json(rows)
    },
  }
  globalThis.fetch=async url=>{assert.equal(new URL(url).hostname,'api.neynar.com');return Response.json({cast})}
})
after(()=>{globalThis.fetch=realFetch;if(oldKey===undefined)delete process.env.NEYNAR_API_KEY;else process.env.NEYNAR_API_KEY=oldKey;delete globalThis.v4Backend;delete globalThis.v4Intake})
function req(body={}, auth=true) {return new Request('https://app.test/api/v4/mining',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{authorization:'Bearer test'}:{})},
  body:JSON.stringify({...deployment,walletAddress:wallet,castHash,...body})})}
test('V4 cast uses verified FID and server chain time; browser reward/day are ignored',async()=>{
  const r=await handler(req({fid:999,day:999,amount:999999,followers:100000,startedAt:0}))
  assert.equal(r.status,201);assert.equal(r.headers.get('cache-control'),'no-store')
  const b=await r.json();assert.equal(b.session.fid,42);assert.equal(b.session.day,0)
  const p=JSON.parse(calls[0].init.body)
  assert.equal(p.p_started_at,new Date(Number(now)*1000).toISOString());assert.equal('amount' in p,false)
  assert.equal(p.p_follower_count,2000,'must use Neynar, not input followers')
  assert.equal(Date.parse(b.session.ends_at)-Date.parse(b.session.started_at),86400000)
})
test('edited text and image-only casts are accepted by canonical hash',async()=>{
  cast.text='';assert.equal((await handler(req({castUrl:'https://farcaster.xyz/me/0x33333333',castHash:undefined}))).status,201)
  assert.equal(rows[0].cast_hash,castHash)
})
test('unauthenticated, other FID and unverified wallet cannot open sessions',async()=>{
  assert.equal((await handler(req({},false))).status,401)
  cast.author.fid=43;assert.equal((await handler(req())).status,403)
  cast.author.fid=42;cast.author.verified_addresses.eth_addresses=[];assert.equal((await handler(req())).status,403)
  assert.equal(inserted,0)
})
test('network mismatch, malformed input and arbitrary cast URLs fail before mutation',async()=>{
  assert.equal((await handler(req({chainId:8453}))).status,409)
  assert.equal((await handler(req({walletAddress:'garbage'}))).status,400)
  assert.equal((await handler(req({castHash:undefined,castUrl:'http://127.0.0.1/admin'}))).status,400)
  assert.equal(inserted,0)
})
test('retrying a saved cast returns its original session without resetting the clock',async()=>{
  const first=await (await handler(req())).json()
  gate.eligible=false;gate.reason='already active'
  const result=await handler(req()), next=await result.json()
  assert.equal(result.status,200);assert.equal(next.resumed,true);assert.deepEqual(first.session,next.session);assert.equal(inserted,1)
})
test('claim-first/active-session gate cannot be bypassed by POST',async()=>{
  gate.eligible=false;gate.reason='Claim your previous reward'
  assert.equal((await handler(req())).status,409);assert.equal(inserted,0)
})
test('old casts cannot start sessions, missing SQL does not leak database details',async()=>{
  cast.timestamp=new Date(Number(now-2n*86400n)*1000).toISOString()
  assert.equal((await handler(req())).status,400)
  globalThis.v4Intake.sessionsV4=async()=>{throw Error('v4_mining_sessions schema cache secret internals')}
  const r=await handler(req());assert.equal(r.status,503);assert.doesNotMatch((await r.json()).error,/secret/)
})
test('public cohort is bounded, chain scoped and explicitly not an allocation certificate',async()=>{
  const r=await handler(new Request('https://app.test/api/v4/mining?action=cohort&day=3'))
  assert.equal(r.status,200);const b=await r.json();assert.equal(b.authoritativeRewards,false);assert.equal(b.nextOffset,null)
  assert.match(calls[0].path,/limit=100/);assert.match(calls[0].path,/chain_id=eq.84532/);assert.match(calls[0].path,/day=eq.3/)
  assert.equal((await handler(new Request('https://app.test/api/v4/mining?action=cohort&day=3%26limit=99999'))).status,400)
})
test('live aggregates are public, correctly scoped, short-cached and never fetch Neynar',async()=>{
  globalThis.fetch=async()=>{throw Error('No API calls per stats poll')}
  globalThis.v4Backend.requireFarcasterUser=()=>{throw Error('Counts require no login')}
  const r=await handler(new Request('https://app.test/api/v4/mining?action=stats&day=7'))
  assert.equal(r.status,200);assert.match(r.headers.get('cache-control'),/s-maxage=10/)
  const b=await r.json();assert.equal(b.scope,'minecast-intake');assert.equal(b.authoritativeRewards,false)
  assert.equal(b.active_miners,'4');assert.equal(b.cohort_miners,'10')
  assert.deepEqual(JSON.parse(calls[0].init.body),{p_chain_id:84532,p_distributor:distributor,p_day:7})
  assert.equal((await handler(new Request('https://app.test/api/v4/mining?action=stats&day=-1'))).status,400)
})
test('missing Neynar follower count is unknown rather than a fabricated x1',async()=>{
  delete cast.author.follower_count
  assert.equal((await handler(req({followers:100000,nodeWork:true}))).status,201)
  const p=JSON.parse(calls[0].init.body)
  assert.equal(p.p_follower_count,null);assert.equal('nodeWork' in p,false)
})
