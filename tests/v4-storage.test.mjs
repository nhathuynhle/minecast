import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

// Optional test tooling lives outside production dependencies. See MINIAPP-INTEGRATION.md.
const require = createRequire(path.resolve(process.env.V4_TEST_TOOLS || '.', 'package.json'))
const { PGlite } = require('@electric-sql/pglite')
const hash = n => '0x' + BigInt(n).toString(16).padStart(40, '0')
test('V4 session migration executes on PostgreSQL and enforces identity/session boundaries', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;')
  const sql = fs.readFileSync('supabase/migrations/20261110_v4_mining_sessions.sql', 'utf8')
  await db.exec(sql); await db.exec(sql) // Safe repeat; no legacy table modifications.
  const estimatesSql = fs.readFileSync('supabase/migrations/20261110_v4_live_estimates.sql','utf8')
  await db.exec(estimatesSql); await db.exec(estimatesSql)
  async function start({ fid=42, wallet=hash(1), cast=hash(100), day=0, time='2030-01-01T00:00:00Z', chain=84532 }={}) {
    return (await db.query('select * from public.start_v4_mining_session($1::integer,$2::text,$3::bigint,$4::text,$5::text,$6::bigint,$7::timestamptz)',
      [chain,hash(2),fid,wallet,cast,day,time])).rows
  }
  await t.test('idempotent cast keeps original start and exact 24-hour end', async () => {
    const [row]=await start(), [again]=await start({time:'2030-01-01T00:05:00Z'})
    assert.equal(row.id,again.id);assert.equal(new Date(row.ends_at)-new Date(row.started_at),86400000)
    assert.equal(String(row.fid),'42')
  })
  await t.test('overlap, duplicate day, identity changes and cast theft are rejected', async () => {
    await assert.rejects(start({cast:hash(101),time:'2030-01-01T01:00:00Z'}),/active session/i)
    await assert.rejects(start({cast:hash(101),time:'2030-01-02T00:00:00Z'}),/duplicate key/i)
    await assert.rejects(start({cast:hash(101),wallet:hash(3),day:1,time:'2030-01-02T00:00:00Z'}),/linked/)
    await assert.rejects(start({cast:hash(101),fid:43,day:1,time:'2030-01-02T00:00:00Z'}),/linked/)
    await assert.rejects(start({fid:43}),/already belongs/)
  })
  await t.test('next cohort and separate chain work without resetting past sessions', async () => {
    assert.equal((await start({cast:hash(102),day:1,time:'2030-01-02T00:00:00Z'})).length,1)
    assert.equal((await start({chain:8453})).length,1)
    assert.equal((await db.query('select count(*) as n from v4_mining_sessions')).rows[0].n,3)
  })
  await t.test('browser roles cannot read the table or invoke SECURITY DEFINER; service role can', async () => {
    for (const role of ['anon','authenticated']) {
      await db.exec('set role '+role)
      await assert.rejects(db.query('select * from public.v4_mining_sessions'),/permission denied/)
      await assert.rejects(start(),/permission denied/)
      await assert.rejects(db.query('select * from get_v4_mining_stats(84532,$1,0)',[hash(2)]),/permission denied/)
      await db.exec('reset role')
    }
    await db.exec('set role service_role')
    assert.equal((await start()).length,1)
    assert.equal((await db.query('select count(*) as n from public.v4_mining_sessions')).rows[0].n,3)
    await db.exec('reset role')
  })
  await t.test('live totals retain completed cohort miners, exclude future starts and isolate deployments',async()=>{
    const now=new Date((await db.query('select now() as n')).rows[0].n).getTime()
    const iso=hours=>new Date(now+hours*3600000).toISOString()
    const create=async({fid,day=7,time=iso(-1),followers=2000,chain=84532,distributor=hash(9)})=>(await db.query(
      'select * from start_v4_mining_session_with_estimate($1::integer,$2::text,$3::bigint,$4::text,$5::text,$6::bigint,$7::timestamptz,$8::bigint)',
      [chain,distributor,fid,hash(fid),hash(fid+1000),day,time,followers])).rows[0]
    await create({fid:100,day:7}) // active, same cohort x10
    await create({fid:101,day:7,time:iso(-30),followers:1000}) // ended, remains in pool x6
    await create({fid:102,day:8,time:iso(-0.5)}) // active, another cohort
    await create({fid:103,day:8,time:iso(1)}) // not started
    await create({fid:104,chain:8453}) // different chain
    await create({fid:105,distributor:hash(10)}) // another deployment
    const read=async()=>(await db.query('select * from get_v4_mining_stats(84532,$1,7)',[hash(9)])).rows[0]
    let s=await read()
    assert.equal(s.active_miners,'2');assert.equal(s.cohort_miners,'2');assert.equal(s.estimated_miners,'2');assert.equal(s.total_weight,'16')
    await create({fid:100,followers:100000}) // repeated cast must retain original observation
    assert.equal((await read()).total_weight,'16')
    await create({fid:106,followers:null})
    s=await read();assert.equal(s.cohort_miners,'3');assert.equal(s.estimated_miners,'2');assert.equal(s.total_weight,'16')
    const tiers=[[0,1],[9,1],[10,2],[499,2],[500,4],[999,4],[1000,6],[1999,6],[2000,10],[4999,10],[5000,18],[10000,30],[25000,50],[50000,75],[100000,100]]
    for(let i=0;i<tiers.length;i++) assert.equal((await create({fid:200+i,day:9,followers:tiers[i][0]})).estimated_weight,tiers[i][1])
  })
})
