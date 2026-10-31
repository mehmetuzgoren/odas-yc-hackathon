import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Config, Clock } from './core';

function envFile(path: string) {
 if (!existsSync(path)) return;
 for (const line of readFileSync(path,'utf8').split(/\r?\n/)) {
  const i=line.indexOf('='); if (i<1 || line.trim().startsWith('#')) continue;
  const key=line.slice(0,i).trim(); const value=line.slice(i+1).trim();
  if (!process.env[key] && value) process.env[key]=value;
 }
}
export function loadConfig(): Config {
 envFile(resolve('.env'));
 const dataDir=resolve(process.env.DATA_DIR || '.data/development');
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 envFile(resolve('.data/private/stripe.env'));
 const privateFile=join(dataDir,'runtime.env'); envFile(privateFile);
 const generated: string[]=[];
 for (const key of ['INTERNAL_TOKEN','TERSE_ACTOR_SECRET']) {
  if (!process.env[key]) { if(process.env.NODE_ENV==='production') throw new Error(`${key} is required in production`); process.env[key]=crypto.randomUUID()+crypto.randomUUID(); generated.push(`${key}=${process.env[key]}`); }
 }
 if(generated.length) writeFileSync(privateFile,(existsSync(privateFile)?readFileSync(privateFile,'utf8'):'')+generated.join('\n')+'\n',{mode:0o600});
 const namespace=process.env.ODAS_NAMESPACE || 'development';
 process.env.ACTOR_PROJECT_ID ||= `odas-${namespace}`;
 process.env.ACTOR_PORT ||= '7100';
 process.env.TERSE_ACTOR_URL ||= `http://127.0.0.1:${process.env.ACTOR_PORT}/v1/projects/${process.env.ACTOR_PROJECT_ID}/actors`;
 process.env.TERSE_API_KEY ||= process.env.TERSE_ACTOR_SECRET;
 const deviceMode=process.env.DEVICE_MODE==='physical'?'physical':'simulator';
 const testMode=process.env.ODAS_TEST_MODE==='1';
 if(testMode && (deviceMode==='physical' || !namespace.startsWith('test-'))) throw new Error('Controlled clocks require an isolated test-* namespace and simulator');
 if(process.env.STRIPE_SECRET_KEY && !/^(sk|rk|rkcs)_test_/.test(process.env.STRIPE_SECRET_KEY)) throw new Error('ODAS MVP accepts Stripe test/sandbox keys only');
 const origin=process.env.APP_ORIGIN || `http://127.0.0.1:${process.env.WEB_PORT||5173}`;
 const config:Config={dataDir,origin,apiPort:Number(process.env.API_PORT||3000),internalToken:process.env.INTERNAL_TOKEN!,namespace,testMode,deviceMode,stripeSecretKey:process.env.STRIPE_SECRET_KEY||undefined,stripeWebhookSecret:process.env.STRIPE_WEBHOOK_SECRET||undefined};
 return config;
}
export function createClock(config:Config):Clock {
 return {now(){
  if(config.testMode) { const path=join(config.dataDir,'clock.json'); if(existsSync(path)){const value=JSON.parse(readFileSync(path,'utf8')).now;if(Number.isSafeInteger(value))return value;} if(process.env.ODAS_TEST_NOW)return Number(process.env.ODAS_TEST_NOW); }
  return Date.now();
 }};
}
