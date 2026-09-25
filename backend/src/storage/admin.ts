import { randomBytes, randomUUID } from 'node:crypto';
import { query, withTransaction } from '../db/pool.js';
import { sealStorageSecret, sha256Bytes, unsealStorageSecret } from './crypto.js';
import { dropboxAuthorizationUrl, dropboxExchangeTokens, DropboxProvider, type DropboxTokens } from './dropbox.js';
import { connectionClient, dropboxSetup, storageAudit, type StorageConnectionRow } from './connections.js';
import { stripControlCharacters } from './text.js';

export class StorageConflict extends Error {}
export class StorageUnavailable extends Error {}

function setupRequired() {
  const setup=dropboxSetup();
  if (!setup) throw new StorageUnavailable('Dropbox setup incomplete');
  return setup;
}

export async function storageStatus() {
  const setup=Boolean(dropboxSetup());
  const [selection,connections]=await Promise.all([
    query<{connection_id:string|null;revision:number}>('SELECT connection_id,revision FROM permit.storage_selection WHERE singleton=true'),
    query<StorageConnectionRow>("SELECT * FROM permit.storage_connections WHERE provider='dropbox' ORDER BY created_at DESC"),
  ]);
  const counts=await query<{connection_id:string;count:string}>(
    'SELECT connection_id,count(*)::text AS count FROM permit.file_registry WHERE connection_id IS NOT NULL GROUP BY connection_id');
  const countById=new Map(counts.rows.map(row=>[row.connection_id,Number(row.count)]));
  return {setupComplete:setup,selectionRevision:selection.rows[0]?.revision ?? 0,
    activeConnectionId:selection.rows[0]?.connection_id ?? null,
    connections:connections.rows.map(row=>({id:row.id,status:row.status,accountLabel:row.account_label,
      revision:row.revision,dependentFiles:countById.get(row.id) ?? 0,
      healthVerified:Boolean(row.last_health_at && !row.last_error_code)}))};
}

export async function startDropboxConnect(actorId:string,sessionId:string) {
  const setup=setupRequired();
  const state=randomBytes(32).toString('base64url');
  const verifier=randomBytes(32).toString('base64url');
  const digest=sha256Bytes(state);
  const current=await query<StorageConnectionRow>(
    "SELECT * FROM permit.storage_connections WHERE provider='dropbox' AND account_id IS NOT NULL ORDER BY created_at DESC LIMIT 1");
  const row=current.rows[0];
  await withTransaction(async db=>{
    await db.query(`INSERT INTO permit.storage_oauth_states
      (state_hash,actor_user_id,session_id,base_connection_id,verifier_envelope,connection_revision,redirect_uri,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')`,
      [digest,actorId,sessionId,row?.id ?? null,sealStorageSecret({verifier},`oauth:${digest.toString('hex')}`,setup.key),row?.revision ?? 0,setup.redirectUri]);
    await storageAudit(db.query.bind(db),actorId,'CONNECT_STARTED',row?.id ?? null);
  });
  return {authorizationUrl:dropboxAuthorizationUrl({clientId:setup.clientId,redirectUri:setup.redirectUri,state,verifier})};
}

export async function completeDropboxConnect(actorId:string,sessionId:string,state:string,code:string) {
  const setup=setupRequired();
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(state) || !code || code.length>8192) throw new StorageConflict('Invalid OAuth callback');
  const digest=sha256Bytes(state);
  const consumed=await query<{base_connection_id:string|null;verifier_envelope:string;connection_revision:number;redirect_uri:string}>(
    `DELETE FROM permit.storage_oauth_states WHERE state_hash=$1 AND actor_user_id=$2 AND session_id=$3
      AND expires_at>now() RETURNING base_connection_id,verifier_envelope,connection_revision,redirect_uri`,[digest,actorId,sessionId]);
  const entry=consumed.rows[0];
  if (!entry || entry.redirect_uri!==setup.redirectUri) throw new StorageConflict('Invalid OAuth callback');
  try {
    const {verifier}=unsealStorageSecret<{verifier:string}>(entry.verifier_envelope,`oauth:${digest.toString('hex')}`,setup.key);
    const tokens=await dropboxExchangeTokens({clientId:setup.clientId,clientSecret:setup.clientSecret,
      redirectUri:setup.redirectUri,code,verifier});
    const provider=new DropboxProvider(tokens.accessToken);
    const account=await provider.account();
    await provider.ensureRoot();
    return await withTransaction(async db=>{
      await db.query('SELECT connection_id FROM permit.storage_selection WHERE singleton=true FOR UPDATE');
      const current=entry.base_connection_id
        ? await db.query<StorageConnectionRow>('SELECT * FROM permit.storage_connections WHERE id=$1 FOR UPDATE',[entry.base_connection_id])
        : await db.query<StorageConnectionRow>("SELECT * FROM permit.storage_connections WHERE provider='dropbox' AND account_id IS NOT NULL FOR UPDATE");
      const row=current.rows[0];
      if ((row?.revision ?? 0)!==entry.connection_revision) throw new StorageConflict('Connection changed');
      const existing=await db.query<StorageConnectionRow>(
        "SELECT * FROM permit.storage_connections WHERE provider='dropbox' AND account_id=$1 FOR UPDATE",[account.id]);
      const same=existing.rows[0];
      const id=same?.id ?? randomUUID();
      const label=stripControlCharacters(account.label).slice(0,200);
      const sealed=sealStorageSecret(tokens,`connection:${id}`,setup.key);
      if (same) await db.query(`UPDATE permit.storage_connections SET account_id=$2,account_label=$3,
        credentials=$4,status='connected',revision=revision+1,token_revision=token_revision+1,
        last_health_at=now(),last_error_code=NULL,updated_at=now(),updated_by=$5 WHERE id=$1`,
        [id,account.id,label,sealed,actorId]);
      else await db.query(`INSERT INTO permit.storage_connections
        (id,provider,status,account_id,account_label,credentials,last_health_at,updated_by)
        VALUES($1,'dropbox','connected',$2,$3,$4,now(),$5)`,[id,account.id,label,sealed,actorId]);
      await storageAudit(db.query.bind(db),actorId,'CONNECTED',id);
      return {connected:true};
    });
  } catch (error) {
    await storageAudit(query,actorId,'CONNECT_FAILED',null);
    if (error instanceof StorageConflict) throw error;
    throw new StorageUnavailable('Dropbox connection could not be completed');
  }
}

export async function testDropboxConnection(actorId:string,connectionId:string) {
  const row=(await query<StorageConnectionRow>("SELECT * FROM permit.storage_connections WHERE id=$1 AND provider='dropbox'",[connectionId])).rows[0];
  if (!row?.credentials) throw new StorageConflict('Dropbox is not connected');
  try {
    const client=await connectionClient(row,query,true);
    if ((await client.account()).id!==row.account_id) throw new Error('Account mismatch');
    await client.ensureRoot();
    await withTransaction(async db=>{
      await db.query("UPDATE permit.storage_connections SET status='connected',last_health_at=now(),last_error_code=NULL WHERE id=$1",[row.id]);
      await storageAudit(db.query.bind(db),actorId,'CONNECTION_TESTED',row.id);
    });
    return {ok:true};
  } catch {
    await withTransaction(async db=>{
      await db.query("UPDATE permit.storage_connections SET status='error',last_error_code='provider_unavailable' WHERE id=$1",[row.id]);
      await storageAudit(db.query.bind(db),actorId,'CONNECTION_TEST_FAILED',row.id);
    });
    throw new StorageUnavailable('Dropbox connection test failed');
  }
}

export async function selectDropbox(actorId:string,revision:number,active:boolean,connectionId?:string) {
  if (active) setupRequired();
  return withTransaction(async db=>{
    const selection=await db.query<{connection_id:string|null;revision:number}>(
      'SELECT connection_id,revision FROM permit.storage_selection WHERE singleton=true FOR UPDATE');
    if (selection.rows[0]?.revision!==revision) throw new StorageConflict('Storage selection changed');
    const row=connectionId ? await db.query<StorageConnectionRow>(
      "SELECT * FROM permit.storage_connections WHERE id=$1 AND provider='dropbox' FOR UPDATE",[connectionId]) : null;
    const connection=row?.rows[0];
    if (active && (!connection || connection.status!=='connected' || !connection.credentials ||
        !connection.last_health_at || connection.last_error_code || Date.now()-new Date(connection.last_health_at).getTime()>10*60_000)) {
      throw new StorageConflict('Test the Dropbox connection before activation');
    }
    await db.query('UPDATE permit.storage_selection SET connection_id=$1,revision=revision+1,updated_at=now(),updated_by=$2 WHERE singleton=true',
      [active?connection?.id:null,actorId]);
    await storageAudit(db.query.bind(db),actorId,active?'ACTIVATED':'DEACTIVATED',connection?.id ?? null);
    return {active};
  });
}

export async function disconnectDropbox(actorId:string,connectionId:string,revision:number) {
  let row:StorageConnectionRow;
  try { row=await withTransaction(async db=>{
    const selection=await db.query<{connection_id:string|null}>('SELECT connection_id FROM permit.storage_selection WHERE singleton=true FOR UPDATE');
    const current=await db.query<StorageConnectionRow>("SELECT * FROM permit.storage_connections WHERE id=$1 AND provider='dropbox' FOR UPDATE",[connectionId]);
    const connection=current.rows[0];
    if (!connection || connection.revision!==revision || !connection.credentials) throw new StorageConflict('Dropbox connection changed');
    const refs=await db.query('SELECT id FROM permit.file_registry WHERE connection_id=$1 LIMIT 1',[connection.id]);
    if (selection.rows[0]?.connection_id===connection.id || refs.rows.length) {
      throw new StorageConflict('Dropbox has active or referenced files');
    }
    await db.query("UPDATE permit.storage_connections SET status='disconnecting',revision=revision+1 WHERE id=$1",[connection.id]);
    return {...connection,revision:connection.revision+1};
  }); } catch (error) {
    if (error instanceof StorageConflict && error.message==='Dropbox has active or referenced files') {
      await storageAudit(query,actorId,'DISCONNECT_REFUSED',connectionId);
    }
    throw error;
  }
  try {
    const setup=setupRequired();
    let tokens=unsealStorageSecret<DropboxTokens>(row.credentials!,`connection:${row.id}`,setup.key);
    if (tokens.expiresAt<Date.now()+60_000) tokens=await dropboxExchangeTokens({clientId:setup.clientId,
      clientSecret:setup.clientSecret,redirectUri:setup.redirectUri,refreshToken:tokens.refreshToken});
    await new DropboxProvider(tokens.accessToken).revoke();
    await withTransaction(async db=>{
      await db.query(`UPDATE permit.storage_connections SET credentials=NULL,account_id=NULL,account_label=NULL,
        status='disconnected',revision=revision+1,token_revision=token_revision+1,updated_at=now(),updated_by=$3,
        last_health_at=NULL,last_error_code=NULL WHERE id=$1 AND revision=$2`,[row.id,row.revision,actorId]);
      await storageAudit(db.query.bind(db),actorId,'DISCONNECTED',row.id);
    });
    return {disconnected:true};
  } catch {
    await withTransaction(async db=>{
      await db.query("UPDATE permit.storage_connections SET status='error',last_error_code='revoke_unconfirmed' WHERE id=$1",[row.id]);
      await storageAudit(db.query.bind(db),actorId,'DISCONNECT_FAILED',row.id);
    });
    throw new StorageUnavailable('Dropbox revocation could not be confirmed');
  }
}
