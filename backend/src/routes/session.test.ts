import assert from 'node:assert/strict';
import http from 'node:http';
import { before, after, test } from 'node:test';
import { Pool, type PoolClient } from 'pg';
import type { PGlite } from '@electric-sql/pglite';
import { installedDatabase } from '../test/permitSchemaFixtures.js';
import { createApp } from '../app.js';
import { hashPassword } from '../domain/auth/passwords.js';
import type { Response as ExpressResponse, CookieOptions } from 'express';
import { setSessionCookie, clearSessionCookie } from '../domain/auth/sessions.js';
import { env } from '../config/env.js';
let db:PGlite;
let server:http.Server;
let url:string;
const query=Pool.prototype.query;
const connect=Pool.prototype.connect;
const USER='10000000-0000-4000-8000-000000000003';
const PASSWORD='FAKE-session-test-password';
const origin='http://localhost:5173';
before(async()=>{
 db=await installedDatabase();
 await db.query('INSERT INTO permit.users(id,email,password_hash,password_scheme) VALUES($1,$2,$3,$4)',[USER,'user@example.invalid',await hashPassword(PASSWORD),'argon2id']);
 await db.query("INSERT INTO permit.app_user_access(user_id,state) VALUES($1,'ACTIVE')",[USER]);
 await db.exec('SET ROLE permit_runtime; SET search_path=pg_catalog,permit,pg_temp');
 Pool.prototype.query=(async(text:unknown,params?:unknown[])=>db.query(String(text),params)) as typeof Pool.prototype.query;
 Pool.prototype.connect=(async()=>({query:db.query.bind(db),release:()=>{}} as unknown as PoolClient)) as typeof Pool.prototype.connect;
 server=http.createServer(createApp());
 await new Promise<void>((r)=>server.listen(0,'127.0.0.1',r));
 url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/v1`;
});
after(async()=>{
 Pool.prototype.query=query; Pool.prototype.connect=connect;
 await new Promise<void>((r)=>server?.close(()=>r())); await db?.close();
});
function post(path:string,body:unknown,headers:Record<string,string>={origin}){
 return fetch(url+path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});
}
test('login returns only an HttpOnly host-only cookie; restoration and logout revoke on the server',async()=>{
 const res=await post('/auth/login',{email:' USER@EXAMPLE.INVALID ',password:PASSWORD});
 assert.equal(res.status,204); assert.equal(await res.text(),'');
 const cookie=res.headers.get('set-cookie')!;
 assert.match(cookie,/permit_session=/);assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Lax/);
 assert.match(cookie,/Path=\/api\/v1/);assert.doesNotMatch(cookie,/Domain=|Max-Age=/);
 const header=cookie.split(';')[0]!;
 const me=await fetch(url+'/auth/me',{headers:{cookie:header}});assert.equal(me.status,200);
 const body=await me.text(); assert.doesNotMatch(body,/password_hash|password_scheme|sessionId|token_hash|FAKE/);
 for(const headers of [{cookie:header},{cookie:header,origin:'https://hostile.invalid'},{cookie:header,origin:'null',referer:origin+'/page'}]){
  assert.equal((await post('/auth/logout',{},headers)).status,403);
 }
 const logout=await post('/auth/logout',{}, {cookie:header,referer:origin+'/page'});
 assert.equal(logout.status,204);assert.match(logout.headers.get('set-cookie')!,/Expires=Thu, 01 Jan 1970/);
 assert.equal((await fetch(url+'/auth/me',{headers:{cookie:header}})).status,401);
});
test('login CSRF rejects missing/foreign origin; credential failures have identical generic bodies',async()=>{
 for(const headers of [{},{origin:'https://hostile.invalid'}]){
  assert.equal((await post('/auth/login',{email:'user@example.invalid',password:PASSWORD},headers)).status,403);
 }
 const wrong=await post('/auth/login',{email:'user@example.invalid',password:'FAKE-wrong'});
 const unknown=await post('/auth/login',{email:'unknown@example.invalid',password:PASSWORD});
 assert.equal(wrong.status,401);assert.equal(unknown.status,401);
 assert.deepEqual(await wrong.json(),await unknown.json());
});
test('remembered session cookie is Secure in production with the same clearing attributes',async()=>{
 const res=await post('/auth/login',{email:'user@example.invalid',password:PASSWORD,remember:true});
 assert.equal(res.status,204);assert.match(res.headers.get('set-cookie')!,/Max-Age=1209600/);
 const previous=env.NODE_ENV;env.NODE_ENV='production';
 try {
  let issued:CookieOptions|undefined;
  let cleared:CookieOptions|undefined;
  const response={cookie:(_name:string,_value:string,options:CookieOptions)=>{issued=options;},
    clearCookie:(_name:string,options:CookieOptions)=>{cleared=options;}} as unknown as ExpressResponse;
  setSessionCookie(response,'synthetic',true);clearSessionCookie(response);
  assert.deepEqual(issued,{httpOnly:true,secure:true,sameSite:'lax',path:'/api/v1',maxAge:1209600000});
  assert.deepEqual(cleared,{httpOnly:true,secure:true,sameSite:'lax',path:'/api/v1'});
 }finally{env.NODE_ENV=previous;}
});
test('login has a finite IP budget and safely rejects brute force',async()=>{
 let last:Response|undefined;
 for(let i=0;i<=env.RATE_LIMIT_LOGIN_MAX;i++) last=await post('/auth/login',{email:'unknown@example.invalid',password:'FAKE-wrong'});
 assert.equal(last?.status,429);
 assert.doesNotMatch(await last!.text(),/FAKE|password_hash|stack|postgres/);
});
