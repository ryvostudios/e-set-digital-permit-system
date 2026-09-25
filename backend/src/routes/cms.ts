import { createHash } from 'node:crypto';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { requireAuth } from '../middleware/auth.js';
import { requireCmsManage } from '../middleware/requireCmsManage.js';
import { requirePrivilegedAccess } from '../middleware/requirePrivilegedAccess.js';
import {
  CmsConflict, CmsInvalid, getCmsState, listCmsAudit, MAX_PDF_LOGOS, readAssetBytes, setPdfLogos, setWebArtwork,
  updateIdentity, uploadAsset,
} from '../domain/cms/cms.js';
import { ICON_SIZES, publicBranding, publicIcon, publicManifest, publicWebLogo, type IconSize } from '../domain/cms/publicBranding.js';
import { ManagedStorageUnavailable } from '../storage/managedFiles.js';
import { hasControlCharacters } from '../storage/text.js';
import { completeDropboxConnect, disconnectDropbox, selectDropbox, startDropboxConnect,
  storageStatus, StorageConflict, StorageUnavailable, testDropboxConnection } from '../storage/admin.js';

export const cmsRouter = Router();
const ceo=requirePrivilegedAccess('CEO');
const revisionSchema=z.object({revision:z.number().int().positive(),connectionId:z.string().uuid()}).strict();

cmsRouter.use('/cms',(_req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  next();
});

function auth(req:Request):{id:string;sessionId:string} {
  if (!req.auth) throw new StorageConflict('Authentication required');
  return req.auth;
}

async function respond(res:Response,action:()=>Promise<unknown>):Promise<void> {
  try { res.status(200).json(await action()); }
  catch (error) {
    if (error instanceof StorageConflict) res.status(409).json({error:'conflict',message:'Storage connection changed or has dependent files'});
    else if (error instanceof StorageUnavailable) res.status(503).json({error:'storage_unavailable',message:'Dropbox integration is unavailable'});
    else res.status(503).json({error:'storage_unavailable',message:'Dropbox integration is unavailable'});
  }
}

cmsRouter.get('/cms/dropbox/status',requireAuth,ceo,async (_req,res)=>respond(res,storageStatus));
cmsRouter.post('/cms/dropbox/connect',requireAuth,ceo,async (req,res)=>respond(res,()=>{
  const actor=auth(req); return startDropboxConnect(actor.id,actor.sessionId);
}));
cmsRouter.get('/cms/dropbox/callback',requireAuth,ceo,async (req,res)=>{
  const body=z.object({state:z.string(),code:z.string()}).strict().safeParse(req.query);
  if (!body.success) {res.status(400).json({error:'invalid_request',message:'Invalid OAuth callback'});return;}
  try {
    const actor=auth(req);
    await completeDropboxConnect(actor.id,actor.sessionId,body.data.state,body.data.code);
    const origin=env.DROPBOX_OAUTH_ORIGIN;
    if (!origin) throw new StorageUnavailable('Callback origin unavailable');
    res.redirect(303,`${origin}/cms/integrations?dropbox=connected`);
  } catch {res.status(503).json({error:'storage_unavailable',message:'Dropbox connection could not be completed'});}
});
cmsRouter.post('/cms/dropbox/test',requireAuth,ceo,async (req,res)=>{
  const body=z.object({connectionId:z.string().uuid()}).strict().safeParse(req.body);
  if (!body.success) {res.status(400).json({error:'invalid_request',message:'Invalid connection'});return;}
  await respond(res,()=>testDropboxConnection(auth(req).id,body.data.connectionId));
});
cmsRouter.post('/cms/dropbox/activate',requireAuth,ceo,async (req,res)=>{
  const body=revisionSchema.safeParse(req.body);
  if (!body.success) {res.status(400).json({error:'invalid_request',message:'Invalid revision'});return;}
  await respond(res,()=>selectDropbox(auth(req).id,body.data.revision,true,body.data.connectionId));
});
cmsRouter.post('/cms/dropbox/deactivate',requireAuth,ceo,async (req,res)=>{
  const body=z.object({revision:z.number().int().positive()}).strict().safeParse(req.body);
  if (!body.success) {res.status(400).json({error:'invalid_request',message:'Invalid revision'});return;}
  await respond(res,()=>selectDropbox(auth(req).id,body.data.revision,false));
});
cmsRouter.post('/cms/dropbox/disconnect',requireAuth,ceo,async (req,res)=>{
  const body=revisionSchema.safeParse(req.body);
  if (!body.success) {res.status(400).json({error:'invalid_request',message:'Invalid revision'});return;}
  await respond(res,()=>disconnectDropbox(auth(req).id,body.data.connectionId,body.data.revision));
});

// ---------------------------------------------------------------------
// Permit CMS (branding, content, audit). Authority: the CEO, or an
// individual explicitly granted `permit.cms.manage` - never a Team +
// Position, never Site Manager/CRO/HSE by role. Dropbox integration above
// stays CEO-only.
// ---------------------------------------------------------------------

const cms = requireCmsManage();

async function cmsRespond(res: Response, action: () => Promise<unknown>): Promise<void> {
  try {
    res.status(200).json(await action());
  } catch (error) {
    if (error instanceof CmsConflict) res.status(409).json({ error: 'conflict', message: 'The CMS changed. Reload and try again.' });
    else if (error instanceof CmsInvalid) res.status(400).json({ error: 'invalid_request', message: error.message });
    else if (error instanceof ManagedStorageUnavailable) {
      res.status(503).json({ error: 'storage_unavailable', message: 'Permit storage is not available. Connect Dropbox first.' });
    } else res.status(503).json({ error: 'cms_unavailable', message: 'The CMS is unavailable right now.' });
  }
}

const revision = z.number().int().positive();
const identitySchema = z.object({
  revision,
  organizationName: z.string().trim().min(1).max(120).refine((value) => !hasControlCharacters(value)),
  signInNotice: z.string().max(500).refine((value) => !hasControlCharacters(value, true)),
}).strict();
const uploadQuery = z.object({
  purpose: z.enum(['PDF_LOGO', 'WEB_LOGO', 'PWA_ICON']),
  label: z.string().trim().min(1).max(80).refine((value) => !hasControlCharacters(value) && !/[<>]/.test(value)),
}).strict();
const pdfLogosSchema = z.object({
  revision,
  logos: z.array(z.object({
    assetId: z.string().uuid(),
    documentTypes: z.array(z.literal('ISSUED_PERMIT')).min(1).max(1),
  }).strict()).max(MAX_PDF_LOGOS),
}).strict();
const artworkSchema = z.object({ revision, assetId: z.string().uuid().nullable() }).strict();

cmsRouter.get('/cms/state', requireAuth, cms, async (_req, res) => cmsRespond(res, () => getCmsState()));

cmsRouter.patch('/cms/identity', requireAuth, cms, async (req, res) => {
  const body = identitySchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'invalid_request', message: 'Invalid identity' }); return; }
  await cmsRespond(res, () => updateIdentity(auth(req).id, body.data));
});

cmsRouter.post('/cms/assets', requireAuth, cms,
  express.raw({ type: ['image/png', 'image/jpeg'], limit: 2 * 1024 * 1024 }),
  async (req, res) => {
    const params = uploadQuery.safeParse(req.query);
    const declaredMime = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!params.success || !Buffer.isBuffer(req.body) || !['image/png', 'image/jpeg'].includes(declaredMime)) {
      res.status(400).json({ error: 'invalid_request', message: 'Upload a PNG or JPEG image' });
      return;
    }
    await cmsRespond(res, () => uploadAsset(auth(req).id, {
      purpose: params.data.purpose, label: params.data.label, declaredMime, bytes: req.body as Buffer,
    }));
  });

cmsRouter.get('/cms/assets/:id/image', requireAuth, cms, async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) { res.status(404).json({ error: 'not_found', message: 'Not found' }); return; }
  try {
    const bytes = await readAssetBytes(id.data);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.status(200).send(bytes);
  } catch {
    res.status(404).json({ error: 'not_found', message: 'Not found' });
  }
});

cmsRouter.put('/cms/pdf-logos', requireAuth, cms, async (req, res) => {
  const body = pdfLogosSchema.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: 'invalid_request', message: `Choose at most ${MAX_PDF_LOGOS} logos` }); return; }
  await cmsRespond(res, () => setPdfLogos(auth(req).id, body.data));
});

for (const [path, kind] of [['/cms/web-logo', 'WEB_LOGO'], ['/cms/pwa-icon', 'PWA_ICON']] as const) {
  cmsRouter.put(path, requireAuth, cms, async (req, res) => {
    const body = artworkSchema.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: 'invalid_request', message: 'Invalid selection' }); return; }
    await cmsRespond(res, () => setWebArtwork(auth(req).id, { ...body.data, kind }));
  });
}

cmsRouter.get('/cms/audit', requireAuth, cms, async (req, res) => {
  const limit = z.coerce.number().int().min(1).max(200).catch(50).parse(req.query.limit);
  await cmsRespond(res, async () => ({ events: await listCmsAudit(limit) }));
});

// ---------------------------------------------------------------------
// Public branding - no authentication, public-safe fields only, and every
// failure falls back to the bundled artwork (the 404 tells the frontend
// to keep its static file). Never blocks sign-in.
// ---------------------------------------------------------------------

export const brandingRouter = Router();

function publicAssetHeaders(res: Response, etag: string | null): void {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Public artwork: safe to embed from the frontend origin in local
  // development, where the API is a different origin.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (etag) res.setHeader('ETag', `"${etag}"`);
}

brandingRouter.get('/branding/public', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.status(200).json(await publicBranding());
});

brandingRouter.get('/branding/web-logo', async (req, res) => {
  const logo = await publicWebLogo();
  if (!logo) { res.status(404).json({ error: 'not_found', message: 'Not found' }); return; }
  publicAssetHeaders(res, logo.version);
  if (req.fresh) { res.status(304).end(); return; }
  res.type('image/png').send(logo.bytes);
});

brandingRouter.get('/branding/icon/:size', async (req, res) => {
  const size = Number(req.params.size);
  if (!(ICON_SIZES as readonly number[]).includes(size)) { res.status(404).json({ error: 'not_found', message: 'Not found' }); return; }
  const icon = await publicIcon(size as IconSize);
  if (!icon) { res.status(404).json({ error: 'not_found', message: 'Not found' }); return; }
  publicAssetHeaders(res, `${icon.version}-${size}`);
  if (req.fresh) { res.status(304).end(); return; }
  res.type('image/png').send(icon.bytes);
});

brandingRouter.get('/branding/manifest.webmanifest', async (req, res) => {
  const body = await publicManifest();
  const etag = createHash('sha256').update(body).digest('hex');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('ETag', `"${etag}"`);
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.fresh) { res.status(304).end(); return; }
  res.type('application/manifest+json').send(body);
});
