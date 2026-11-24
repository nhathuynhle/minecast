import test from 'node:test'
import assert from 'node:assert/strict'
import { loadModule } from './v4-test-loader.mjs'
// Rewards now depend on likes and recasts counted at the cohort close, so the app shows live counts, not a reward estimate.
const { parseLiveStats } = await loadModule('src/lib/v4/estimates.ts')
const config = {chainId:84532,distributor:'0x'+'1'.repeat(40)}
const packet = {protocol:'open-v4-quorum-1', ...config, day:0, scope:'minecast-intake', estimateBasis:'follower-only',authoritativeRewards:false,
  observed_at:'2030-01-01T07:00:00Z',active_miners:'40',cohort_miners:'200',estimated_miners:'200',total_weight:'2000'}

test('wrong chain, day, source and inconsistent aggregate data are rejected',()=>{
  for(const patch of [{chainId:8453},{day:1},{distributor:'0x'+'2'.repeat(40)},{scope:'all-network'},{authoritativeRewards:true},
    {cohort_miners:200},{total_weight:'-1'},{estimated_miners:'201'},{total_weight:'20001'},{observed_at:'invalid'}]) {
    assert.throws(()=>parseLiveStats({...packet,...patch},config,0n))
  }
})
