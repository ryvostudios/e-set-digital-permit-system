import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction, type QueryFn } from '../db/pool.js';
import type { DocumentStorageAdapter, DocumentStorageContext, DocumentStorageResult, DocumentDownloadResult } from '../domain/permits/documents.js';
import { activeConnection, connectionClient, type StorageConnectionRow } from './connections.js';
import { DropboxProvider } from './dropbox.js';
import { filePath } from './paths.js';

interface FileRow {
  id:string;provider:'dropbox'|'legacy_supabase';connection_id:string|null;
  logical_key:string;remote_path:string;remote_id:string|null;
  state:'pending'|'ready'|'cleanup_pending';
  size_bytes:string;sha256:string;document_job_id:string|null;
}
type StorageClient = Pick<DropboxProvider,'account'|'ensureRoot'|'upload'|'download'|'metadata'>;

export interface StorageDeps {
  query:QueryFn;
  withTransaction:<T>(fn:(client:PoolClient)=>Promise<T>)=>Promise<T>;
  active:(queryFn:QueryFn)=>Promise<StorageConnectionRow|null>;
  client:(connection:StorageConnectionRow)=>Promise<StorageClient>;
}

const productionDeps:StorageDeps={query,withTransaction,active:activeConnection,
  client:(connection)=>connectionClient(connection,query,true)};

function hash(bytes:Buffer):string { return createHash('sha256').update(bytes).digest('hex'); }

function validLogicalKey(value:string):boolean {
  return /^permits\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.pdf$/i.test(value);
}

export class PermitDocumentStorage implements DocumentStorageAdapter {
  constructor(private readonly legacy:DocumentStorageAdapter|null,private readonly deps:StorageDeps=productionDeps) {}

  async preflight():Promise<DocumentStorageResult> {
    try {
      const connection=await this.deps.active(this.deps.query);
      if (!connection || connection.status!=='connected') return {ok:false,code:'STORAGE_NOT_CONFIGURED'};
      const client=await this.deps.client(connection);
      const account=await client.account();
      if (account.id!==connection.account_id) return {ok:false,code:'STORAGE_PREFLIGHT_FAILED'};
      await client.ensureRoot();
      return {ok:true};
    } catch { return {ok:false,code:'STORAGE_PREFLIGHT_FAILED'}; }
  }

  private async reserve(logicalKey:string,data:Buffer,context:DocumentStorageContext):Promise<{file:FileRow;connection:StorageConnectionRow}> {
    const sha256=hash(data);
    const year=new Date(context.issuedAt).getUTCFullYear();
    const remotePath=filePath({category:'ISSUED_PDF',year,permitNumber:context.permitNumber,
      identity:`${context.permitNumber}-${context.documentJobId}`,extension:'pdf'});
    return this.deps.withTransaction(async db=>{
      await db.query('SELECT connection_id FROM permit.storage_selection WHERE singleton=true FOR UPDATE');
      const existing=await db.query<FileRow>(`SELECT * FROM permit.file_registry WHERE document_job_id=$1 FOR UPDATE`,[context.documentJobId]);
      let file=existing.rows[0];
      let connection:StorageConnectionRow|undefined;
      if (file) {
        const row=await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections WHERE id=$1 FOR UPDATE',[file.connection_id]);
        connection=row.rows[0];
      } else {
        const row=await db.query<StorageConnectionRow>(`SELECT c.* FROM permit.storage_selection s
          JOIN permit.storage_connections c ON c.id=s.connection_id WHERE s.singleton=true FOR UPDATE OF c`);
        connection=row.rows[0];
      }
      if (!connection || connection.status!=='connected' || !connection.credentials) throw new Error('Permit storage connection unavailable');
      if (file) {
        if (file.provider!=='dropbox' || file.logical_key!==logicalKey || file.remote_path!==remotePath ||
            Number(file.size_bytes)!==data.length || file.sha256!==sha256 || file.connection_id!==connection.id) {
          throw new Error('Permit storage reservation conflict');
        }
      } else {
        const inserted=await db.query<FileRow>(`INSERT INTO permit.file_registry
          (provider,connection_id,logical_key,remote_path,category,related_permit_id,related_jsa_id,
           document_job_id,original_filename,mime_type,size_bytes,sha256,created_by)
          VALUES ('dropbox',$1,$2,$3,'ISSUED_PDF',$4,$5,$6,$7,'application/pdf',$8,$9,$10)
          RETURNING *`,[connection.id,logicalKey,remotePath,context.permitId,context.jsaId,
            context.documentJobId,`${context.permitNumber}.pdf`,data.length,sha256,context.actorUserId]);
        file=inserted.rows[0];
      }
      if (!file) throw new Error('Permit storage reservation missing');
      return {file,connection};
    });
  }

  async upload(logicalKey:string,data:Buffer,contentType:string,context?:DocumentStorageContext):Promise<DocumentStorageResult> {
    if (!context || !validLogicalKey(logicalKey) || contentType!=='application/pdf' || !Buffer.isBuffer(data) ||
        data.length===0 || data.length>256*1024*1024 || !data.subarray(0,5).equals(Buffer.from('%PDF-'))) {
      return {ok:false,code:'STORAGE_UPLOAD_FAILED'};
    }
    try {
      const {file,connection}=await this.reserve(logicalKey,data,context);
      if (file.state==='ready') return {ok:true,reference:`file:${file.id}`};
      const client=await this.deps.client(connection);
      const remoteId=await client.upload(file.remote_path,data);
      await this.deps.query(`UPDATE permit.file_registry SET remote_id=$2,state='ready' WHERE id=$1 AND state IN ('pending','cleanup_pending')`,
        [file.id,remoteId]);
      return {ok:true,reference:`file:${file.id}`};
    } catch { return {ok:false,code:'STORAGE_UPLOAD_FAILED'}; }
  }

  private async readRegistered(file:FileRow,recover:boolean):Promise<DocumentDownloadResult> {
    try {
      if (file.provider!=='dropbox' || !file.connection_id || (!recover && file.state!=='ready')) return {ok:false,code:'STORAGE_DOWNLOAD_FAILED'};
      const row=await this.deps.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections WHERE id=$1',[file.connection_id]);
      const connection=row.rows[0];
      if (!connection) return {ok:false,code:'STORAGE_DOWNLOAD_FAILED'};
      const client=await this.deps.client(connection);
      let remoteId=file.remote_id;
      if (!remoteId && recover) {
        const metadata=await client.metadata(`/${file.remote_path}`);
        remoteId=typeof metadata.id==='string'?metadata.id:null;
      }
      if (!remoteId) return {ok:false,code:'STORAGE_DOWNLOAD_FAILED'};
      const data=await client.download(remoteId);
      if (data.length!==Number(file.size_bytes) || hash(data)!==file.sha256) return {ok:false,code:'STORAGE_INTEGRITY_MISMATCH'};
      if (recover && file.state!=='ready') {
        await this.deps.query(`UPDATE permit.file_registry SET remote_id=$2,state='ready' WHERE id=$1 AND state IN ('pending','cleanup_pending')`,
          [file.id,remoteId]);
      }
      return {ok:true,data,reference:`file:${file.id}`};
    } catch { return {ok:false,code:'STORAGE_DOWNLOAD_FAILED'}; }
  }

  async download(reference:string):Promise<DocumentDownloadResult> {
    if (/^file:[a-f0-9-]{36}$/i.test(reference)) {
      const row=await this.deps.query<FileRow>("SELECT * FROM permit.file_registry WHERE id=$1 AND provider='dropbox'",[reference.slice(5)]);
      const file=row.rows[0];
      return file?this.readRegistered(file,false):{ok:false,code:'STORAGE_DOWNLOAD_FAILED'};
    }
    if (!validLogicalKey(reference)) return {ok:false,code:'STORAGE_DOWNLOAD_FAILED'};
    const row=await this.deps.query<FileRow>("SELECT * FROM permit.file_registry WHERE logical_key=$1 AND provider='dropbox' ORDER BY created_at DESC LIMIT 1",[reference]);
    if (row.rows[0]) return this.readRegistered(row.rows[0],true);
    return this.legacy ? this.legacy.download(reference) : {ok:false,code:'STORAGE_NOT_CONFIGURED'};
  }
}
