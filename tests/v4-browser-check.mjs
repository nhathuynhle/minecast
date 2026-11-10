import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

// Invoked only with V4_BROWSER_CHECK=1; uses the isolated test chain, never public RPC.
export async function checkBrowser(config, rpc, miner, t) {
  const require = createRequire(path.resolve(process.env.V4_TEST_TOOLS, 'package.json'))
  const { chromium } = require('playwright')
  const env = { ...process.env, VITE_MINING_PROTOCOL: 'v4', VITE_V4_CHAIN_ID: '84532', VITE_V4_RPC_URL: rpc }
  for (const key of ['token','distributor','staking','dao','registry']) env['VITE_V4_'+key.toUpperCase()+'_ADDRESS']=config[key]
  const vite=spawn(process.execPath,['node_modules/vite/bin/vite.js','--host','127.0.0.1','--port','5197','--strictPort'],{
    windowsHide:true,env,stdio:['ignore','pipe','pipe'],
  })
  t.after(()=>vite.kill())
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('Vite startup timeout')),20000)
    vite.once('error',e=>{clearTimeout(timer);reject(e)})
    vite.once('exit',code=>{clearTimeout(timer);reject(Error('Vite exited '+code))})
    createInterface({input:vite.stdout}).on('line',line=>{if(line.includes('127.0.0.1:5197')){clearTimeout(timer);resolve()}})
  })
  const browser=await chromium.launch({channel:'msedge',headless:true})
  t.after(()=>browser.close())
  const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1})
  await context.addInitScript(({config,miner})=>{
    localStorage.setItem('minecast:v4:'+config.chainId+':'+config.distributor.toLowerCase()+':account',JSON.stringify(miner))
  },{config,miner})
  const page=await context.newPage(), pageErrors=[]
  page.setDefaultTimeout(15000)
  page.on('pageerror',e=>pageErrors.push(e.message))
  t.after(async()=>{ if(!page.isClosed()) { fs.mkdirSync('tests/build.local',{recursive:true}); await page.screenshot({path:'tests/build.local/v4-last-browser-state.png',fullPage:true}).catch(()=>{}) } })
  await page.goto('http://127.0.0.1:5197',{waitUntil:'domcontentloaded'})
  await page.getByRole('heading',{name:'Mining session',exact:true}).waitFor()
  await page.getByText('My mining days',{exact:true}).click()
  await page.getByRole('textbox',{name:'Mining day',exact:true}).fill('40')
  await page.getByText(/TOKENCAST claimed onchain/).waitFor()
  assert.equal(await page.getByRole('button',{name:'Post cast & start 24h',exact:true}).isEnabled(),false,'outside Farcaster cannot cast')
  const directory='tests/build.local'
  fs.mkdirSync(directory,{recursive:true})
  await page.screenshot({path:path.join(directory,'v4-mine-mobile.png'),fullPage:true})
  const overflow=()=>page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth)
  assert.equal(await overflow(),false,'mine layout horizontal overflow')
  await page.getByRole('button',{name:'DAO',exact:true}).click()
  await page.getByRole('heading',{name:'Stake',exact:true}).waitFor()
  await page.getByText('Total staked',{exact:true}).waitFor()
  await page.getByRole('textbox',{name:'Month (UTC · YYYYMM)'}).fill('203003')
  await page.getByText('Settled',{exact:true}).waitFor()
  assert.equal(await overflow(),false,'DAO layout horizontal overflow')
  await page.screenshot({path:path.join(directory,'v4-dao-mobile.png'),fullPage:true})
  await page.setViewportSize({width:320,height:740})
  assert.equal(await overflow(),false,'320px layout horizontal overflow')
  await page.setViewportSize({width:1280,height:900})
  await page.screenshot({path:path.join(directory,'v4-dao-desktop.png'),fullPage:true})
  await page.getByRole('button',{name:'Token',exact:true}).click()
  await page.getByRole('heading',{name:'V4 contracts',exact:true}).waitFor()
  assert.equal(await page.locator('a[href*="/address/"]').count(),5)
  assert.deepEqual(pageErrors,[])
}
