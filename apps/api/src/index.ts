import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { serveStatic } from 'hono/bun';
import { bodyLimit } from 'hono/body-limit';
import { timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { loadConfig, createClock } from './config';
import { openDatabase } from './db';
import { HttpError, type Runtime } from './core';
import { modelStatus } from './ai';

export async function createApp() {
 const config=loadConfig();const db=await openDatabase(config.dataDir);
 const [{createRoomGateway},{createCatalogService,createCatalogRoutes},{createCommerceService,createCommerceRoutes},{createOperationsService,createOperationsRoutes},{createConciergeService,createConciergeRoutes}]=await Promise.all([import('./operations/gateway'),import('./catalog'),import('./commerce'),import('./operations'),import('./concierge')]);
 const rt:Runtime={config,db,clock:createClock(config),rooms:createRoomGateway(),services:{} as Runtime['services']};
 rt.services.catalog=createCatalogService(rt);rt.services.commerce=createCommerceService(rt);rt.services.operations=createOperationsService(rt);rt.services.concierge=createConciergeService(rt);
 const app=new Hono();
 app.use('*',async(c,next)=>{c.header('X-Content-Type-Options','nosniff');c.header('Referrer-Policy','same-origin');c.header('X-Frame-Options','DENY');if(c.req.path.startsWith('/api/'))c.header('Cache-Control','no-store');await next();});
 app.use('/api/*',bodyLimit({maxSize:1_048_576,onError:c=>c.json({error:'Request is too large.'},413)}));
 app.use('/api/*',async(c,next)=>{
  if(['GET','HEAD','OPTIONS'].includes(c.req.method))return next();
  if(c.req.path==='/api/payments/webhook')return next();
  if(c.req.path.startsWith('/api/internal/')){
   const provided=c.req.header('Authorization')||'';const expected=`Bearer ${config.internalToken}`;
   if(provided.length!==expected.length||!timingSafeEqual(Buffer.from(provided),Buffer.from(expected)))return c.json({error:'Internal authentication required.'},401);
   return next();
  }
  if(c.req.header('Origin')!==config.origin)return c.json({error:'This request must come from the ODAS application.',code:'invalid_origin'},403);
  const token=c.req.header('X-CSRF-Token')||'';
  let expected=getCookie(c,'odas_csrf')||'';
  const session=getCookie(c,'odas_session');if(session){const hash=new Bun.CryptoHasher('sha256').update(session).digest('hex');const row=await db.query('SELECT csrf_token FROM sessions WHERE id_hash=? AND expires_at>?').get(hash,rt.clock.now()) as any;if(row)expected=row.csrf_token;}
  if(!token||!expected||token.length!==expected.length||!timingSafeEqual(Buffer.from(token),Buffer.from(expected)))return c.json({error:'Refresh the page and try again.',code:'invalid_csrf'},403);
  return next();
 });
 app.get('/api/health',c=>c.json({ok:true,application:'ODAS',contractVersion:1,database:db.dialect,namespace:config.namespace,inventory:'modeled',devices:config.deviceMode,payments:config.stripeSecretKey?'stripe_sandbox':'unconfigured',concierge:modelStatus().mode,model:modelStatus().model}));
 app.route('/api',createCatalogRoutes(rt));app.route('/api',createCommerceRoutes(rt));app.route('/api',createOperationsRoutes(rt));app.route('/api',createConciergeRoutes(rt));
 app.all('/api/*',c=>c.json({error:'API route not found.'},404));
 const webRoot=resolve('apps/web/dist');
 if(existsSync(join(webRoot,'index.html'))){app.use('/*',serveStatic({root:'./apps/web/dist'}));app.get('*',c=>c.html(Bun.file(join(webRoot,'index.html')).text()));}
 else app.get('*',c=>c.text('ODAS API is running. Open the Vite frontend during development.',200));
 app.onError((error,c)=>{if(error instanceof HttpError)return c.json({error:error.message,...(error.code?{code:error.code}:{})},error.status as any);if(error.name==='ZodError')return c.json({error:'Check the submitted information.',code:'invalid_input'},400);console.error('[api]',error instanceof Error?error.message:'Unexpected error');return c.json({error:'We could not complete that request. Please try again.'},500);});
 return {app,runtime:rt};
}
if(import.meta.main){
 const {app,runtime}=await createApp();
 const server=Bun.serve({port:runtime.config.apiPort,hostname:process.env.API_HOST||'127.0.0.1',fetch:app.fetch,idleTimeout:120});
 console.log(`ODAS API listening on http://${server.hostname}:${server.port}`);
 let stopped=false;
 async function maintenance(){while(!stopped){try{await runtime.services.commerce.recover();await runtime.services.operations.tick();}catch(error){console.warn('[maintenance]',error instanceof Error?error.message:'Retry pending');}await new Promise(r=>setTimeout(r,3000));}}
 void maintenance();
 const stop=async ()=>{stopped=true;server.stop();await runtime.db.close();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
}
