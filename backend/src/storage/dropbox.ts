import { createHash } from 'node:crypto';
import { PERMIT_DROPBOX_ROOT } from './paths.js';

const API_ORIGIN = 'https://api.dropboxapi.com';
const CONTENT_ORIGIN = 'https://content.dropboxapi.com';
const MAX_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const SCOPES = 'account_info.read files.metadata.read files.content.write files.content.read';

export class DropboxError extends Error {
  constructor(readonly status = 0, readonly missing = false) {
    super('Permit Dropbox operation failed');
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DropboxError();
  return value as Record<string, unknown>;
}

function string(value: unknown, max = 8192): string {
  if (typeof value !== 'string' || !value || value.length > max) throw new DropboxError();
  return value;
}

async function boundedBody(response: Response, max: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > max) throw new DropboxError();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body ?? []) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > max) throw new DropboxError();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export class DropboxHttp {
  constructor(private readonly transport: typeof fetch = fetch) {}

  async request(url: string, init: RequestInit, binary = false): Promise<Record<string, unknown> | Buffer> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || ![API_ORIGIN,CONTENT_ORIGIN].includes(target.origin) ||
        target.username || target.password || target.hash) throw new DropboxError();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.transport(url,{...init,redirect:'error',signal:controller.signal});
      if (!response.ok) {
        // Dropbox reports a missing path as a structured 409. Never return
        // or log the provider response; only inspect a bounded shape.
        let missing = response.status === 404;
        if (response.status === 409) {
          const body = await boundedBody(response,16_384);
          try { missing = object(object(JSON.parse(body.toString())).error).path !== undefined; }
          catch { /* generic provider failure */ }
        } else await response.body?.cancel();
        throw new DropboxError(response.status,missing);
      }
      const body = await boundedBody(response,binary?MAX_BYTES:1024*1024);
      if (binary) return body;
      return body.length ? object(JSON.parse(body.toString('utf8'))) : {};
    } catch (error) {
      if (error instanceof DropboxError) throw error;
      throw new DropboxError();
    } finally { clearTimeout(timeout); }
  }
}

export function dropboxAuthorizationUrl(input: {clientId:string;redirectUri:string;state:string;verifier:string}): string {
  const challenge = createHash('sha256').update(input.verifier).digest('base64url');
  const params = new URLSearchParams({client_id:input.clientId,redirect_uri:input.redirectUri,response_type:'code',
    state:input.state,scope:SCOPES,token_access_type:'offline',code_challenge:challenge,code_challenge_method:'S256'});
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

export interface DropboxTokens { accessToken:string; refreshToken:string; expiresAt:number }

export async function dropboxExchangeTokens(input: {
  clientId:string;clientSecret:string;redirectUri:string;
  code?:string;verifier?:string;refreshToken?:string;
}, http = new DropboxHttp()): Promise<DropboxTokens> {
  const body = new URLSearchParams({client_id:input.clientId,client_secret:input.clientSecret});
  if (input.code && input.verifier) {
    body.set('grant_type','authorization_code'); body.set('code',input.code);
    body.set('code_verifier',input.verifier); body.set('redirect_uri',input.redirectUri);
  } else if (input.refreshToken) {
    body.set('grant_type','refresh_token'); body.set('refresh_token',input.refreshToken);
  } else throw new DropboxError();
  const result = object(await http.request(`${API_ORIGIN}/oauth2/token`,{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded'},body}));
  const expires = Number(result.expires_in);
  if (!Number.isFinite(expires) || expires <= 0 || expires > 86_400) throw new DropboxError();
  if (result.scope && !SCOPES.split(' ').every(scope=>String(result.scope).split(' ').includes(scope))) throw new DropboxError();
  return {accessToken:string(result.access_token),refreshToken:string(result.refresh_token || input.refreshToken),
    expiresAt:Date.now()+expires*1000};
}

/** Dropbox's content hash is SHA-256 of concatenated 4 MiB block digests. */
export function dropboxContentHash(buffer: Buffer): string {
  const blocks: Buffer[] = [];
  for (let index=0;index<buffer.length;index+=4*1024*1024) {
    blocks.push(createHash('sha256').update(buffer.subarray(index,index+4*1024*1024)).digest());
  }
  return createHash('sha256').update(Buffer.concat(blocks)).digest('hex');
}

export class DropboxProvider {
  constructor(private readonly token: string, private readonly http = new DropboxHttp()) {}
  private headers(extra: Record<string,string> = {}): Record<string,string> {
    return {Authorization:`Bearer ${this.token}`,...extra};
  }
  private async rpc(name: string, payload: unknown): Promise<Record<string,unknown>> {
    return object(await this.http.request(`${API_ORIGIN}/2/${name}`,{method:'POST',
      headers:this.headers({'Content-Type':'application/json'}),body:JSON.stringify(payload)}));
  }
  async account(): Promise<{id:string;label:string}> {
    const row=await this.rpc('users/get_current_account',null);
    return {id:string(row.account_id,200),label:string(row.email || object(row.name).display_name,200)};
  }
  async metadata(pathOrId: string): Promise<Record<string,unknown>> {
    if (!/^\/[A-Za-z0-9 _./-]{1,1000}$/.test(pathOrId) && !/^id:[A-Za-z0-9_-]{1,200}$/.test(pathOrId)) throw new DropboxError();
    return this.rpc('files/get_metadata',{path:pathOrId});
  }
  async folder(path: string): Promise<void> {
    try { await this.rpc('files/create_folder_v2',{path:`/${path}`,autorename:false}); }
    catch (error) {
      if (!(error instanceof DropboxError) || error.status !== 409) throw error;
      const found=await this.metadata(`/${path}`);
      if (found['.tag'] !== 'folder') throw new DropboxError();
    }
  }
  async ensureRoot(): Promise<void> {
    await this.folder(PERMIT_DROPBOX_ROOT);
    const root=await this.metadata(`/${PERMIT_DROPBOX_ROOT}`);
    if (root['.tag'] !== 'folder') throw new DropboxError();
  }
  async ensureParents(path: string): Promise<void> {
    const parts=path.split('/'); parts.pop();
    for (let i=1;i<=parts.length;i++) await this.folder(parts.slice(0,i).join('/'));
  }
  private async content(method:string,args:unknown,body:Buffer):Promise<Record<string,unknown>> {
    return object(await this.http.request(`${CONTENT_ORIGIN}/2/files/${method}`,{method:'POST',
      headers:this.headers({'Content-Type':'application/octet-stream','Dropbox-API-Arg':JSON.stringify(args)}),body}));
  }
  async upload(path: string, buffer: Buffer): Promise<string> {
    if (!path.startsWith(`${PERMIT_DROPBOX_ROOT}/`) || path.includes('..') || path.length>1000 || buffer.length>MAX_BYTES || buffer.length===0) throw new DropboxError();
    await this.ensureParents(path);
    const commit={path:`/${path}`,mode:'add',autorename:false,strict_conflict:true,mute:true};
    let file:Record<string,unknown>;
    try {
      if (buffer.length<=CHUNK_BYTES) file=await this.content('upload',commit,buffer);
      else {
        const started=await this.content('upload_session/start',{close:false},buffer.subarray(0,CHUNK_BYTES));
        const sessionId=string(started.session_id,200);
        let offset=CHUNK_BYTES;
        while (buffer.length-offset>CHUNK_BYTES) {
          await this.content('upload_session/append_v2',{cursor:{session_id:sessionId,offset},close:false},buffer.subarray(offset,offset+CHUNK_BYTES));
          offset+=CHUNK_BYTES;
        }
        file=await this.content('upload_session/finish',{cursor:{session_id:sessionId,offset},commit},buffer.subarray(offset));
      }
    } catch (error) {
      if (!(error instanceof DropboxError) || error.status !== 409) throw error;
      file=await this.metadata(`/${path}`);
    }
    if (Number(file.size)!==buffer.length || file.content_hash!==dropboxContentHash(buffer)) throw new DropboxError();
    return string(file.id,200);
  }
  async download(id: string): Promise<Buffer> {
    if (!/^id:[A-Za-z0-9_-]{1,200}$/.test(id)) throw new DropboxError();
    return await this.http.request(`${CONTENT_ORIGIN}/2/files/download`,{method:'POST',
      headers:this.headers({'Dropbox-API-Arg':JSON.stringify({path:id})})},true) as Buffer;
  }
  async revoke(): Promise<void> { await this.rpc('auth/token/revoke',null); }
}
