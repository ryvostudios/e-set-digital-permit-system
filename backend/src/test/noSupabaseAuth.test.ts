import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

/** Strip comments, retaining string literals/imports and executable code. */
function codeOnly(source:string) {
 const scanner=ts.createScanner(ts.ScriptTarget.Latest,false,ts.LanguageVariant.JSX,source);
 let out='';
 for(let kind=scanner.scan();kind!==ts.SyntaxKind.EndOfFileToken;kind=scanner.scan()){
  if(kind!==ts.SyntaxKind.SingleLineCommentTrivia&&kind!==ts.SyntaxKind.MultiLineCommentTrivia)out+=scanner.getTokenText();
 }
 return out;
}
async function scan(dir:string):Promise<string[]> {
 const found:string[]=[];
 for(const entry of await readdir(dir,{withFileTypes:true})){
  const p=path.join(dir,entry.name);
  if(entry.isDirectory()) {if(entry.name!=='test')found.push(...await scan(p));}
  else if(/\.tsx?$/.test(p)&&!p.includes('.test.'))found.push(p);
 }
 return found;
}
test('production source contains no Supabase Auth SDK, API, token validation or auth.users SQL',async()=>{
 const root=fileURLToPath(new URL('../../..',import.meta.url));
 const offenders:string[]=[];
 // @supabase/storage-js and S3/Dropbox storage adapters remain permitted.
 const forbidden=/@supabase\/(?:supabase-js|auth-js)|\.auth\s*\.\s*(?:signIn\w*|signOut|getSession|getUser|getClaims|onAuthStateChange|refreshSession|admin)\b|\/auth\/v1\b|\bauth\s*\.\s*users\b|SUPABASE_(?:URL|PUBLISHABLE_KEY|SERVICE_ROLE_KEY|AUTH_ADMIN)/;
 for(const dir of ['backend/src','frontend/src'])for(const file of await scan(path.join(root,dir))){
  const relative=path.relative(root,file);
  if(OFFLINE_IMPORT.includes(relative))continue;
  if(forbidden.test(codeOnly(await readFile(file,'utf8'))))offenders.push(relative);
 }
 assert.deepEqual(offenders,[]);
});

/**
 * The ONE reviewed exception: the offline standalone -> shared data import
 * reads the OLD standalone database's `auth.users` (source rows only, never
 * the shared database, never Supabase Auth APIs). It must stay reachable only
 * from its operator script, never from the API or a worker.
 */
const OFFLINE_IMPORT=['backend/src/db/standaloneImport.ts'];
test('the offline standalone import is imported only by its operator script',async()=>{
 const root=fileURLToPath(new URL('../../..',import.meta.url));
 const importers:string[]=[];
 for(const file of await scan(path.join(root,'backend/src'))){
  if(/from\s+['"][^'"]*standaloneImport\.js['"]/.test(codeOnly(await readFile(file,'utf8'))))importers.push(path.relative(root,file));
 }
 assert.deepEqual(importers,['backend/src/scripts/importStandalone.ts']);
});
