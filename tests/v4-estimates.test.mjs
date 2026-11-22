import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './v4-test-loader.mjs'
const { estimateV4Reward, parseLiveStats } = await loadModule('src/lib/v4/estimates.ts')
const { buildOpenReport } = await import('../research/v4/open-report.mjs')
const { miningPoolForDay } = await import('../research/v4/node/bootstrap-model.mjs')
const config = {chainId:84532,distributor:'0x'+'1'.repeat(40)}
const packet = {protocol:'open-v4-quorum-1', ...config, day:0, scope:'minecast-intake', estimateBasis:'follower-only',authoritativeRewards:false,
  observed_at:'2030-01-01T07:00:00Z',active_miners:'40',cohort_miners:'200',estimated_miners:'200',total_weight:'2000'}

test('estimate uses cohort weight and retains finished miners, not live/online count',()=>{
  const stats=parseLiveStats(packet,config,0n), pool=10000n*10n**18n
  assert.equal(estimateV4Reward(pool,stats,10),10n*10n**18n) // 2,000 units sit below the 10,000-unit floor
  assert.equal(estimateV4Reward(pool,{...stats,activeMiners:0n},10),10n*10n**18n)
  assert.equal(estimateV4Reward(pool,{...stats,cohortMiners:400n,estimatedMiners:400n,totalWeight:40000n},10),25n*10n**17n)
})
test('the total-weight floor explains why adding a few miners does not change an estimate',()=>{
  const pool=miningPoolForDay(0n), stats=parseLiveStats(packet,config,0n)
  for(const n of [1n,2n,20n,100n]) assert.equal(estimateV4Reward(pool,{...stats,cohortMiners:n,estimatedMiners:n,totalWeight:n*100n},100),pool/100n)
  for(const n of [1n,2n,20n,100n]) assert.equal(estimateV4Reward(pool,{...stats,cohortMiners:n,estimatedMiners:n,totalWeight:n},1),pool/10000n)
})
test('a burn-boost level raises the estimate and the per-wallet cap by 0.2 per level',()=>{
  const stats=parseLiveStats(packet,config,0n), pool=10000n*10n**18n
  assert.equal(estimateV4Reward(pool,stats,10,1),12n*10n**18n)
  assert.equal(estimateV4Reward(pool,{...stats,cohortMiners:2n,estimatedMiners:2n,totalWeight:200n},100,4),pool*9n/500n) // 1.8% cap binds
  assert.equal(estimateV4Reward(pool,{...stats,cohortMiners:2n,estimatedMiners:2n,totalWeight:200n},100,9),pool/50n) // x200 ceiling: 2%
  assert.equal(estimateV4Reward(pool,stats,10,10),null)
  assert.equal(estimateV4Reward(pool,stats,10,0,10),20n*10n**18n) // 10 invites: x2
  assert.equal(estimateV4Reward(pool,stats,10,0,25),20n*10n**18n) // invites stop at 10
  assert.equal(estimateV4Reward(pool,{...stats,totalWeight:20000n},100,0,10),estimateV4Reward(pool,{...stats,totalWeight:20000n},100)) // inside the x100 cap
  assert.equal(estimateV4Reward(pool,{...stats,totalWeight:20000n},100,9),estimateV4Reward(pool,{...stats,totalWeight:20000n},100,5)) // x200 ceiling
  assert.equal(estimateV4Reward(pool,stats,10,0,-1),null)
})
test('unknown follower weights and missing observations do not produce fabricated rewards',()=>{
  const stats=parseLiveStats(packet,config,0n)
  for(const weight of [undefined,null,0,101,1.5,NaN]) assert.equal(estimateV4Reward(10000n,stats,weight),null)
  assert.equal(estimateV4Reward(10000n,{...stats,estimatedMiners:199n},10),null)
  assert.equal(estimateV4Reward(10000n,{...stats,cohortMiners:0n,estimatedMiners:0n,totalWeight:0n},10),null)
})
test('wrong chain, day, source and inconsistent aggregate data are rejected',()=>{
  for(const patch of [{chainId:8453},{day:1},{distributor:'0x'+'2'.repeat(40)},{scope:'all-network'},{authoritativeRewards:true},
    {cohort_miners:200},{total_weight:'-1'},{estimated_miners:'201'},{total_weight:'20001'},{observed_at:'invalid'}]) {
    assert.throws(()=>parseLiveStats({...packet,...patch},config,0n))
  }
})
test('no-node estimates match Open V4 allocation math across mixed follower tiers',()=>{
  const launch=1893456000n, counts=[0,10,500,1000,2000,5000,10000,25000,50000,100000], weights=[1,2,4,6,10,18,30,50,75,100]
  for (const length of [320, 400]) { // 9,472 and 11,840 base units: below and above the 10,000-unit floor
    const entries=Array.from({length},(_,i)=>({fid:BigInt(i+1),wallet:'0x'+(i+1).toString(16).padStart(40,'0'),followers:BigInt(counts[i%10]),
      nodeWork:false,castHash:'0x'+(i+1).toString(16).padStart(40,'0'),startedAt:launch+100n}))
    const bundle=buildOpenReport({chainId:84532,distributor:config.distributor,day:0n,launchTime:launch,entries,sourceHash:'0x'+'3'.repeat(64)})
    // Reports count weight in fiftieths (invites and burn-boost levels); follower-only estimates use whole base units.
    const stats={...parseLiveStats(packet,config,0n),cohortMiners:BigInt(length),estimatedMiners:BigInt(length),totalWeight:bundle.report.totalWeight/50n}
    entries.forEach((_,i)=>assert.equal(estimateV4Reward(miningPoolForDay(0n),stats,weights[i%10]),bundle.amounts[i]))
  }
})
