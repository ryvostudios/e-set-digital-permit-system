import { env } from '../config/env.js';
import { query, type QueryFn } from '../db/pool.js';
import { storageKey, sealStorageSecret, unsealStorageSecret } from './crypto.js';
import { DropboxProvider, dropboxExchangeTokens, type DropboxTokens } from './dropbox.js';

export interface StorageConnectionRow {
  id:string;
  provider:'dropbox';
  status:'disconnected'|'connected'|'error'|'disconnecting';
  account_id:string|null;
  account_label:string|null;
  credentials:string|null;
  revision:number;
  token_revision:number;
  last_health_at:string|null;
  last_error_code:string|null;
}

export function dropboxSetup(): {clientId:string;clientSecret:string;redirectUri:string;key:ReturnType<typeof storageKey>} | null {
  if (!env.DROPBOX_CLIENT_ID || !env.DROPBOX_CLIENT_SECRET || !env.DROPBOX_OAUTH_ORIGIN || !env.PERMIT_STORAGE_MASTER_KEY) return null;
  return {clientId:env.DROPBOX_CLIENT_ID,clientSecret:env.DROPBOX_CLIENT_SECRET,
    redirectUri:`${env.DROPBOX_OAUTH_ORIGIN}/api/v1/cms/dropbox/callback`,
    key:storageKey(env.PERMIT_STORAGE_KEY_VERSION,env.PERMIT_STORAGE_MASTER_KEY)};
}

export async function activeConnection(queryFn: QueryFn = query): Promise<StorageConnectionRow | null> {
  const result=await queryFn<StorageConnectionRow>(`SELECT c.* FROM permit.storage_selection s
    JOIN permit.storage_connections c ON c.id=s.connection_id WHERE s.singleton=true`);
  return result.rows[0] ?? null;
}

export async function connectionClient(connection: StorageConnectionRow, queryFn: QueryFn = query,
  allowError = false): Promise<DropboxProvider> {
  const setup=dropboxSetup();
  if (!setup || !connection.credentials || !['connected',...(allowError?['error']:[])].includes(connection.status) ||
      !connection.account_id) throw new Error('Permit Dropbox connection unavailable');
  let tokens=unsealStorageSecret<DropboxTokens>(connection.credentials,`connection:${connection.id}`,setup.key);
  if (tokens.expiresAt < Date.now()+60_000) {
    tokens=await dropboxExchangeTokens({clientId:setup.clientId,clientSecret:setup.clientSecret,
      redirectUri:setup.redirectUri,refreshToken:tokens.refreshToken});
    const sealed=sealStorageSecret(tokens,`connection:${connection.id}`,setup.key);
    const updated=await queryFn<{id:string}>(`UPDATE permit.storage_connections
      SET credentials=$2,token_revision=token_revision+1,updated_at=now()
      WHERE id=$1 AND revision=$3 AND token_revision=$4 AND status IN ('connected','error') RETURNING id`,
      [connection.id,sealed,connection.revision,connection.token_revision]);
    if (!updated.rows.length) {
      const latest=await queryFn<StorageConnectionRow>('SELECT * FROM permit.storage_connections WHERE id=$1',[connection.id]);
      const row=latest.rows[0];
      if (!row?.credentials || row.revision!==connection.revision ||
          !['connected',...(allowError?['error']:[])].includes(row.status)) throw new Error('Permit Dropbox connection changed');
      tokens=unsealStorageSecret<DropboxTokens>(row.credentials,`connection:${row.id}`,setup.key);
    }
  }
  return new DropboxProvider(tokens.accessToken);
}

export async function storageAudit(queryFn: QueryFn, actorUserId:string,
  eventType:'CONNECT_STARTED'|'CONNECTED'|'CONNECT_FAILED'|'CONNECTION_TESTED'|'CONNECTION_TEST_FAILED'|'ACTIVATED'|'DEACTIVATED'|'DISCONNECT_REFUSED'|'DISCONNECTED'|'DISCONNECT_FAILED',
  connectionId:string|null):Promise<void> {
  await queryFn(`INSERT INTO permit.storage_audit_events(actor_user_id,event_type,connection_id) VALUES($1,$2,$3)`,
    [actorUserId,eventType,connectionId]);
}
