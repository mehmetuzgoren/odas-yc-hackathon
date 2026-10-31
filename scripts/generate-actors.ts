import { loadConfig } from '../apps/api/src/config';
loadConfig();
const child=Bun.spawn(['bun','node_modules/terse-cli/dist/index.js','actor','generate','--out-dir','apps/api/src/generated','--non-interactive'],{stdout:'pipe',stderr:'pipe',env:process.env});
const code=await child.exited;
for(const stream of [child.stdout,child.stderr]){let output=await new Response(stream).text();for(const key of ['TERSE_API_KEY','TERSE_ACTOR_SECRET','INTERNAL_TOKEN']){const secret=process.env[key];if(secret)output=output.replaceAll(secret,'[redacted]');}if(output.trim())console.log(output.trim());}
process.exit(code);
