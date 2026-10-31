import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../apps/api/src/config';
import { openDatabase } from '../apps/api/src/db';

const args=process.argv.slice(2);
function option(name:string){const index=args.indexOf(name);return index>=0?args[index+1]:undefined;}
const email=z.email().parse(option('--email'));
const name=z.string().min(1).max(100).parse(option('--name')||'ODAS operator');
const groups=(option('--groups')||'').split(',').map(v=>v.trim()).filter(Boolean);
if(!groups.length)throw new Error('Pass explicit workspace IDs with --groups polk-310,mission-400.');
const config=loadConfig();const db=openDatabase(config.dataDir);
if(db.query('SELECT id FROM users WHERE email=?').get(email))throw new Error('This email already has an account. This command does not promote guests or reset credentials.');
for(const id of groups)if(!db.query('SELECT id FROM workspace_groups WHERE id=?').get(id))throw new Error(`Unknown workspace ID: ${id}`);
const password=process.env.OPERATOR_PASSWORD||`Odas!${crypto.randomUUID()}`;
z.string().min(12).max(200).parse(password);
const hash=await Bun.password.hash(password,{algorithm:'argon2id',memoryCost:65536,timeCost:3});
const id=`operator_${crypto.randomUUID()}`;
const allowPhysical=args.includes('--allow-physical');
db.transaction(()=>{db.query('INSERT INTO users(id,email,password_hash,name,role,test_account,created_at) VALUES(?,?,?,?,\'operator\',?,?)').run(id,email.toLowerCase(),hash,name,allowPhysical?0:1,Date.now());for(const group of groups)db.query('INSERT INTO operator_scopes(user_id,group_id) VALUES(?,?)').run(id,group);})();
let credentialFile:string|undefined;
if(!process.env.OPERATOR_PASSWORD){credentialFile=join(config.dataDir,`${id}-credentials.json`);writeFileSync(credentialFile,JSON.stringify({email,password},null,2)+'\n',{mode:0o600});}
console.log(JSON.stringify({operatorId:id,email,workspaceIds:groups,physicalDevicePermission:allowPhysical,credentialFile:credentialFile||'Password supplied through OPERATOR_PASSWORD; no plaintext file written.'},null,2));
db.close();
