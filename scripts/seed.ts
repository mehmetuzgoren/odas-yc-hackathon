import { openDatabase } from '../apps/api/src/db';
import { loadConfig } from '../apps/api/src/config';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'bun:sqlite';

export const inventory = [
 ['polk-310','507 Polk St, Suite 310','507 Polk St, Suite 310',9,357,37.78157,-122.41898],
 ['mission-400','1360 Mission St, Floor 4 / Suite 400','1360 Mission St, Floor 4 / Suite 400',8,523,37.77588,-122.41563],
 ['market-1540-f3','1540 Market St, Floor 3','1540 Market St, Floor 3',7,609,37.77503,-122.41996],
 ['gough-207','44 Gough St, Suite 207','44 Gough St, Suite 207',1,633,37.77385,-122.42225],
 ['post-204','2211 Post St, Suite 204','2211 Post St, Suite 204',3,650,37.78441,-122.43829],
 ['market-870-1242','870 Market St, Suite 1242','870 Market St, Suite 1242',3,730,37.78511,-122.40722],
] as const;
const polkRoomNames = ['Lion', 'Butterfly', 'Fox', 'Otter', 'Owl', 'Dolphin', 'Panda', 'Falcon', 'Deer'] as const;
export async function seed(db:Database, dataDir:string, devAccounts=false) {
 const now=Date.now();
 db.transaction(()=>{
  for (const [id,name,address,count,rate,lat,lng] of inventory) {
   db.query('INSERT OR IGNORE INTO workspace_groups(id,name,address,latitude,longitude,base_rate_cents,timezone,modeled,description,hours_json,photos_json,attributes_json,access_instructions) VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?)').run(id,name,address,lat,lng,rate,'America/Los_Angeles',`Modeled workspace group with ${count} separately bookable offices. Property details and access are unverified.`,JSON.stringify({open:'08:00',close:'20:00',days:[1,2,3,4,5,6,7],modeled:true}),'[]','{}',null);
   for(let i=1;i<=count;i++) {
    const number = String(i).padStart(2,'0');
    const officeId = `${id}-office-${number}`;
    const defaultName = `Office ${number}`;
    const defaultDescription = `Separately bookable modeled office ${number}. Capacity, dimensions, and amenities are not verified.`;
    const roomName = id === 'polk-310' ? polkRoomNames[i - 1] : defaultName;
    const description = id === 'polk-310' ? `${roomName} is a separately bookable modeled office. Capacity, dimensions, and amenities are not verified.` : defaultDescription;
    db.query('INSERT OR IGNORE INTO offices(id,group_id,name,description,rate_cents,modeled,photos_json,attributes_json,device_binding_json) VALUES(?,?,?,?,NULL,1,?,?,?)').run(officeId,id,roomName,description,'[]','{}',i===1 && id==='polk-310'?JSON.stringify({mode:'simulator',label:'Development simulator, no physical hardware'}):null);
    if (id === 'polk-310') {
     db.query('UPDATE offices SET name=? WHERE id=? AND name=?').run(roomName,officeId,defaultName);
     db.query('UPDATE offices SET description=? WHERE id=? AND description=?').run(description,officeId,defaultDescription);
    }
   }
  }
 })();
 if(devAccounts){
  const accountFile=join(dataDir,'dev-accounts.json');
  let saved:any=existsSync(accountFile)?JSON.parse(readFileSync(accountFile,'utf8')):{};
  for(const role of ['guest','operator'] as const){
   const email=process.env[`DEV_${role.toUpperCase()}_EMAIL`]||`${role}@odas.local`;
   const password=process.env[`DEV_${role.toUpperCase()}_PASSWORD`]||saved[role]?.password||`Odas!${crypto.randomUUID()}`;
   const id=`dev-${role}`;
   const exists=db.query('SELECT id FROM users WHERE email=?').get(email);
   if(!exists){const hash=await Bun.password.hash(password,{algorithm:'argon2id',memoryCost:19456,timeCost:2});db.query('INSERT INTO users(id,email,password_hash,name,role,test_account,created_at) VALUES(?,?,?,?,?,1,?)').run(id,email,hash,role==='operator'?'ODAS operator':'ODAS guest',role,now);}
   saved[role]={email,password};
   if(role==='operator')for(const group of inventory) db.query('INSERT OR IGNORE INTO operator_scopes(user_id,group_id) VALUES(?,?)').run(id,group[0]);
  }
  writeFileSync(accountFile,JSON.stringify(saved,null,2)+'\n',{mode:0o600});
 }
}
if(import.meta.main){const config=loadConfig();const db=openDatabase(config.dataDir);await seed(db,config.dataDir,process.argv.includes('--dev-accounts')); console.log('Seeded 6 modeled workspaces and 31 offices.'+(process.argv.includes('--dev-accounts')?` Credentials: ${join(config.dataDir,'dev-accounts.json')}`:''));db.close();}
