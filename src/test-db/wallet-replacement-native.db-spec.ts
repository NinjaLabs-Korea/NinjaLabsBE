import { execFileSync } from 'child_process';
import { join } from 'path';
import { describeDb } from './describe-db';
import { TEST_DB_URL_ENV } from './harness';

/** Outside Jest's ESM stubs: actual SDK, ADR-36/EIP-191 and isolated Postgres. No chain I/O. */
describeDb('native wallet replacement cryptography and uncertain responses', () => {
  it('covers four signature combinations, post-expiry retry/cleanup and lost committed responses', () => {
    const script = String.raw`
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {Wallet,keccak256}=require('ethers');
const {getInjectiveAddress}=require('@injectivelabs/sdk-ts');
const {serializeSignDoc}=require('@cosmjs/amino');
const {Logger}=require('@nestjs/common');
const {DatabaseService}=require('./src/common/database/database.service');
const {AuditService}=require('./src/audit/audit.service');
const {WalletReplacementService}=require('./src/wallets/wallet-replacement.service');
const {MaintenanceService}=require('./src/common/maintenance/maintenance.service');
const {buildAdr36SignDoc}=require('./src/common/crypto/adr36');
Logger.overrideLogger(false);
const url=process.env.WALLET_CRYPTO_TEST_DB;
if(!/^\/ninjalabs_test_[a-z0-9_]+$/.test(new URL(url).pathname))throw Error('isolated test DB required');
const values={NODE_ENV:'test',DATABASE_URL:url,PGSSLMODE:process.env.TEST_PGSSLMODE||'disable',DATABASE_CA_CERT:process.env.DATABASE_CA_CERT,WALLET_REPLACEMENT_ENABLED:'true'};
const config={get:k=>values[k]},db=new DatabaseService(config),audit=new AuditService(db),service=new WalletReplacementService(db,audit,config);
const pub=w=>Buffer.from(w.signingKey.compressedPublicKey.slice(2),'hex').toString('base64');
async function fixture(){const k=randomUUID(),user=(await db.query('INSERT INTO "user" (google_id,email,nickname,onboarding_step) VALUES ($1,$2,$3,4) RETURNING id',[k,k+'@example.invalid','native_'+k.slice(0,8)])).rows[0].id,old=Wallet.createRandom(),next=Wallet.createRandom();await db.query('INSERT INTO wallet (user_id,address,verified_at) VALUES ($1,$2,now())',[user,getInjectiveAddress(old.address)]);return{user,old,next};}
async function sign(w,kind,message){if(kind==='EVM')return w.signMessage(message);const addr=getInjectiveAddress(w.address),s=w.signingKey.sign(keccak256(serializeSignDoc(buildAdr36SignDoc(addr,message))));return Buffer.from(s.r.slice(2)+s.s.slice(2),'hex').toString('base64');}
async function prepare(f,from,to){const a=await service.createChallenge(f.user,from==='EVM'?f.old.address:getInjectiveAddress(f.old.address),to==='EVM'?f.next.address:getInjectiveAddress(f.next.address));return{a,proof:{challengeId:a.id,currentSignature:await sign(f.old,from,a.currentMessage),newSignature:await sign(f.next,to,a.newMessage),...(from==='ADR36'?{currentPublicKey:pub(f.old)}:{}),...(to==='ADR36'?{newPublicKey:pub(f.next)}:{})}};}
(async()=>{const paths=[];
for(const[from,to]of[['EVM','EVM'],['EVM','ADR36'],['ADR36','EVM'],['ADR36','ADR36']]){
const f=await fixture(),{a,proof}=await prepare(f,from,to);
if(to==='ADR36')await assert.rejects(service.verify(f.user,{...proof,newPublicKey:pub(Wallet.createRandom())}),e=>e.message==='INVALID_SIGNATURE');
if(from==='ADR36'){const{currentPublicKey,...missing}=proof;await assert.rejects(service.verify(f.user,missing),e=>e.message==='INVALID_SIGNATURE');}
const wallet=await service.verify(f.user,proof);assert.equal(wallet.address,getInjectiveAddress(f.next.address));
await db.query("UPDATE wallet_replacement_challenge SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",[a.id]);assert.equal((await service.verify(f.user,proof)).id,wallet.id);
await db.query("UPDATE wallet_replacement_challenge SET expires_at=clock_timestamp()-interval '2 days' WHERE id=$1",[a.id]);await new MaintenanceService(db).sweep();await assert.rejects(service.verify(f.user,proof),e=>e.message==='WALLET_CHANGE_NOT_FOUND');
assert.equal((await db.query('SELECT id FROM wallet WHERE user_id=$1 AND is_primary AND disconnected_at IS NULL',[f.user])).rows[0].id,wallet.id);paths.push(from+'->'+to);}
const f=await fixture(),{proof}=await prepare(f,'ADR36','EVM');let once=true;
const proxy={query:db.query.bind(db),tx:async(fn)=>{const result=await db.tx(fn);if(once){once=false;throw Error('SIMULATED_LOST_COMMIT_ACK');}return result;}};
await assert.rejects(new WalletReplacementService(proxy,audit,config).verify(f.user,proof),e=>e.message==='SIMULATED_LOST_COMMIT_ACK');
const wallet=(await db.query('SELECT id,address FROM wallet WHERE user_id=$1 AND is_primary AND disconnected_at IS NULL',[f.user])).rows[0];assert.equal(wallet.address,getInjectiveAddress(f.next.address));assert.equal((await service.verify(f.user,proof)).id,wallet.id);
assert.equal((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE action='WALLET_REPLACED' AND entity_id=$1",[f.user])).rows[0].n,1);
console.log(JSON.stringify({paths,postExpiryRetry:true,cleanupRecovery:true,lostResponseRetry:true}));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.onApplicationShutdown());
`;
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
      cwd: join(__dirname, '../..'), encoding: 'utf8', timeout: 25_000,
      env: { ...process.env, WALLET_CRYPTO_TEST_DB: process.env[TEST_DB_URL_ENV] }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(output)).toEqual({ paths: ['EVM->EVM', 'EVM->ADR36', 'ADR36->EVM', 'ADR36->ADR36'], postExpiryRetry: true, cleanupRecovery: true, lostResponseRetry: true });
  });
});
