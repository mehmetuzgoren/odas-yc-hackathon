import { loadConfig } from '../apps/api/src/config';
import { openDatabase } from '../apps/api/src/db';
import { seed } from './seed';
import { resolve, join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

export async function launch(development:boolean){
 const config=loadConfig();
 if(!development && (!process.env.TERSE_ACTOR_URL||/127\.0\.0\.1|localhost/.test(process.env.TERSE_ACTOR_URL)))throw new Error('Production requires the managed Terse actor URL and API key; local actor dev is not a production hosting path.');
 const root=resolve('.');const apiPort=String(config.apiPort);const relayPort=process.env.RELAY_PORT||'8787';
 Object.assign(process.env,{DATA_DIR:config.dataDir,DEVICE_PORT:process.env.DEVICE_PORT||'8090',API_PORT:apiPort,API_INTERNAL_URL:`http://127.0.0.1:${apiPort}`,API_BASE_URL:`http://127.0.0.1:${apiPort}`,ODAS_INTERNAL_TOKEN:config.internalToken,DEVICE_MODE:config.deviceMode,ODAS_NAMESPACE:config.namespace,RELAY_BASE_URL:process.env.RELAY_BASE_URL||process.env.RELAYCAST_BASE_URL||`http://127.0.0.1:${relayPort}`,CONCIERGE_MODE:process.env.CONCIERGE_MODE||(process.env.OPENAI_API_KEY?'model':'rules')});
 const children:{name:string;process:ReturnType<typeof Bun.spawn>}[]=[];
 const secrets=['DATABASE_URL','TEST_DATABASE_URL','TERSE_API_KEY','TERSE_ACTOR_SECRET','INTERNAL_TOKEN','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','MODEL_API_KEY','OPENAI_API_KEY'].map(k=>process.env[k]).filter(Boolean) as string[];
 let stopping=false;
 function redact(s:string){for(const secret of secrets)s=s.replaceAll(secret,'[redacted]');return s.replace(/((?:TERSE_API_KEY|STRIPE_SECRET_KEY|workspaceKey|apiToken)=)\S+/g,'$1[redacted]');}
 async function pipe(name:string,stream:ReadableStream<Uint8Array>){const reader=stream.getReader();const decoder=new TextDecoder();let pending='';for(;;){const{done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let i;while((i=pending.indexOf('\n'))>=0){const line=pending.slice(0,i);pending=pending.slice(i+1);if(line.trim())console.log(`[${name}] ${redact(line)}`);}}if(pending.trim())console.log(`[${name}] ${redact(pending)}`);}
 function start(name:string,cmd:string[],cwd=root,extra:Record<string,string>={}){const child=Bun.spawn(cmd,{cwd,env:{...process.env,...extra},stdout:'pipe',stderr:'pipe',stdin:'ignore'});children.push({name,process:child});void pipe(name,child.stdout as ReadableStream<Uint8Array>);void pipe(name,child.stderr as ReadableStream<Uint8Array>);void child.exited.then(code=>{if(!stopping){console.error(`[${name}] exited (${code}); stopping the stack.`);stop(code||1);}});return child;}
 function stop(code=0){if(stopping)return;stopping=true;for(const child of [...children].reverse())child.process.kill('SIGTERM');setTimeout(()=>{for(const child of children)try{child.process.kill('SIGKILL');}catch{}process.exit(code);},3000);}
 process.on('SIGINT',()=>stop());process.on('SIGTERM',()=>stop());
 async function wait(url:string,headers:Record<string,string>={},timeout=90_000){const deadline=Date.now()+timeout;while(Date.now()<deadline){try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(1000)});if(r.status<500)return;}catch{}if(stopping)throw new Error('Startup interrupted');await new Promise(r=>setTimeout(r,350));}throw new Error(`Timed out waiting for ${url}`);}
 async function run(cmd:string[],cwd=root){const child=Bun.spawn(cmd,{cwd,env:process.env,stdout:'pipe',stderr:'pipe'});await Promise.all([pipe('setup',child.stdout),pipe('setup',child.stderr)]);if(await child.exited!==0)throw new Error('Startup setup failed');}
 try{
  const db=await openDatabase(config.dataDir);await seed(db,config.dataDir,development);await db.close();
  if(development){start('actors',['bun',join(root,'node_modules/terse-cli/dist/index.js'),'actor','dev','--port',process.env.ACTOR_PORT!,'--project-id',process.env.ACTOR_PROJECT_ID!],join(root,'packages/actors'),{DURABLE_ACTORS_DATA_DIR:join(config.dataDir,'actors')});await wait(`http://127.0.0.1:${process.env.ACTOR_PORT}/`);await run(['bun','scripts/generate-actors.ts']);}
  const relayUrl=process.env.RELAY_BASE_URL!;
  if(!process.env.RELAY_EXTERNAL){let node=process.env.RELAY_NODE_BINARY||'node';const nvm=process.env.NVM_DIR||(process.env.HOME?join(process.env.HOME,'.nvm'):undefined);if(!process.env.RELAY_NODE_BINARY&&nvm){const versions=join(nvm,'versions/node');if(existsSync(versions)){const v=readdirSync(versions).filter(v=>v.startsWith('v22.')).sort().at(-1);if(v)node=join(versions,v,'bin/node');}}start('relay',[node,'node_modules/@relaycast/engine/dist/bin/serve.js','--db',join(config.dataDir,'relaycast.sqlite'),'--port',relayPort,'--base-url',relayUrl,'--env',development?'development':'production']);}
  await wait(`${relayUrl}/health`);
  await run(['bun','packages/concierge/src/provision.ts']);
  start('devices',['uv','run','--project','workers/device','python','-m','odas_device'],root,{PYTHONUNBUFFERED:'1'});await wait(`http://127.0.0.1:${process.env.DEVICE_PORT}/health`,{Authorization:`Bearer ${config.internalToken}`});
  start('api',['bun',...(development&&!config.testMode?['--watch']:[]),'apps/api/src/index.ts']);await wait(`http://127.0.0.1:${apiPort}/api/health`);
  start('operations',['bun','packages/concierge/src/worker.ts','--role','operations']);start('concierge',['bun','packages/concierge/src/worker.ts','--role','concierge']);
  if(development){start('web',['bun',join(root,'node_modules/vite/bin/vite.js'),'--host',process.env.WEB_HOST||'127.0.0.1','--port',process.env.WEB_PORT||'5173'],join(root,'apps/web'));}
  console.log(`ODAS ready: ${development?config.origin:`http://127.0.0.1:${apiPort}`} (${config.deviceMode}; ${process.env.CONCIERGE_MODE} concierge)`);
  if(development)console.log(`Development credentials: ${join(config.dataDir,'dev-accounts.json')}`);
  await new Promise(()=>{});
 }catch(error){console.error(redact(error instanceof Error?error.message:String(error)));stop(1);}
}
