import { useEffect, useState, type FormEvent } from 'react';
import {
  activateDropbox, deactivateDropbox, disconnectDropbox, downloadCmsAsset, getCmsState, getDropboxStatus, listCmsAudit,
  setCmsPdfLogos, setCmsWebArtwork, startDropboxConnect, testDropboxConnection, updateCmsIdentity, uploadCmsAsset,
  type CmsAsset, type CmsAssetPurpose, type CmsState, type DropboxStatus,
} from '../../api/endpoints';
import { asApiError } from '../../api/errors';
import { useCurrentUser } from '../../auth/useAuth';
import { useApiResource } from '../../lib/useApiResource';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Alert, ErrorState, SkeletonRows } from '../../ui/Feedback';
import { Badge, Card, PageHeader, TabPanel, Tabs } from '../../ui/Layout';

/**
 * The Permit CMS. Permit-only: nothing here reaches ESDMS.
 *
 * WHO: the CEO, or a person the CEO explicitly granted `permit.cms.manage`.
 * The Dropbox integration tab is CEO-only. Hiding a tab is a courtesy -
 * every call is re-authorized by the server.
 *
 * WHAT CHANGES WHAT: identity, logos and artwork apply to documents issued
 * and pages loaded FROM NOW ON. An issued permit keeps the branding it was
 * issued with, byte for byte.
 */

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function message(error: unknown): string {
  return asApiError(error).message;
}

function AssetPreview({ asset }: { asset: CmsAsset }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    downloadCmsAsset(asset.id)
      .then(({ blob }) => {
        if (!active || blob.type !== 'image/png') return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset.id]);
  return (
    <span className="cms-asset__preview">
      {url ? <img src={url} alt={`${asset.label} preview`} style={{ maxHeight: 48, maxWidth: 160, objectFit: 'contain' }} /> : null}
    </span>
  );
}

function UploadForm({ purpose, onUploaded, hint }: { purpose: CmsAssetPurpose; onUploaded: () => void; hint: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `cms-upload-${purpose.toLowerCase()}`;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!file || !label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await uploadCmsAsset(file, purpose, label.trim());
      setFile(null);
      setLabel('');
      onUploaded();
    } catch (caught) {
      setError(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="stack" aria-label={`Upload ${purpose}`}>
      <Input label="Label" name={`${id}-label`} value={label} maxLength={80} onChange={(event) => setLabel(event.target.value)} />
      <label className="field__label" htmlFor={id}>Image (PNG or JPEG, up to 2 MB)</label>
      <input
        id={id}
        type="file"
        accept="image/png,image/jpeg"
        onChange={(event) => {
          const selected = event.target.files?.[0] ?? null;
          setError(null);
          if (selected && (!['image/png', 'image/jpeg'].includes(selected.type) || selected.size > MAX_UPLOAD_BYTES)) {
            setError('Choose a PNG or JPEG image of at most 2 MB.');
            setFile(null);
            return;
          }
          setFile(selected);
        }}
      />
      <p className="muted">{hint}</p>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button type="submit" loading={busy} disabled={!file || !label.trim()}>Upload</Button>
    </form>
  );
}

function IdentityTab({ state, reload }: { state: CmsState; reload: () => void }) {
  const [organizationName, setOrganizationName] = useState(state.organizationName);
  const [signInNotice, setSignInNotice] = useState(state.signInNotice);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setStatus(null);
    try {
      await updateCmsIdentity({ revision: state.revision, organizationName, signInNotice });
      setStatus('Saved.');
      reload();
    } catch (caught) {
      setStatus(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Organization and application content">
      <form onSubmit={save} className="stack">
        <Input
          label="Organization name"
          name="organizationName"
          value={organizationName}
          maxLength={120}
          hint="Printed as the issuer on permits issued from now on."
          onChange={(event) => setOrganizationName(event.target.value)}
        />
        <label className="field__label" htmlFor="signInNotice">Sign-in notice (public, plain text)</label>
        <textarea id="signInNotice" rows={3} maxLength={500} value={signInNotice} onChange={(event) => setSignInNotice(event.target.value)} />
        {status ? <p role="status">{status}</p> : null}
        <Button type="submit" loading={busy}>Save</Button>
      </form>
    </Card>
  );
}

function PdfLogosTab({ state, reload }: { state: CmsState; reload: () => void }) {
  const logos = state.assets.filter((asset) => asset.purpose === 'PDF_LOGO');
  const [order, setOrder] = useState<string[]>(
    logos.filter((asset) => asset.active).sort((a, b) => a.displayOrder - b.displayOrder).map((asset) => asset.id),
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const byId = new Map(logos.map((asset) => [asset.id, asset]));

  function toggle(id: string): void {
    setOrder((current) => (current.includes(id)
      ? current.filter((entry) => entry !== id)
      : current.length < state.maxPdfLogos ? [...current, id] : current));
  }

  function move(index: number, delta: number): void {
    setOrder((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  }

  async function save(): Promise<void> {
    setBusy(true);
    setStatus(null);
    try {
      await setCmsPdfLogos(state.revision, order);
      setStatus('Saved. Applies to permits issued from now on.');
      reload();
    } catch (caught) {
      setStatus(message(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <Card title={`Logos printed on issued permits (up to ${state.maxPdfLogos}, left to right)`}>
        <ol aria-label="Printed logo order">
          {order.map((id, index) => (
            <li key={id}>
              {byId.get(id)?.label}{' '}
              <Button size="sm" variant="secondary" onClick={() => move(index, -1)} disabled={index === 0}>Move left</Button>{' '}
              <Button size="sm" variant="secondary" onClick={() => move(index, 1)} disabled={index === order.length - 1}>Move right</Button>
            </li>
          ))}
        </ol>
        {order.length === 0 ? <p className="muted">No logos are printed. Issued permits show the organization name only.</p> : null}
        <p className="muted">Issued permits keep the logos they were issued with. Transparent areas are printed on white.</p>
        {status ? <p role="status">{status}</p> : null}
        <Button onClick={() => void save()} loading={busy}>Save printed logos</Button>
      </Card>
      <Card title="Uploaded PDF logos">
        <ul>
          {logos.map((asset) => (
            <li key={asset.id}>
              <label>
                <input
                  type="checkbox"
                  checked={order.includes(asset.id)}
                  disabled={!order.includes(asset.id) && order.length >= state.maxPdfLogos}
                  onChange={() => toggle(asset.id)}
                />{' '}
                {asset.label}
              </label>{' '}
              <AssetPreview asset={asset} />
            </li>
          ))}
        </ul>
        <UploadForm purpose="PDF_LOGO" onUploaded={reload} hint="A tightly cropped logo prints best. 32 to 4096 pixels per side." />
      </Card>
    </div>
  );
}

function ArtworkSection({ state, reload, purpose, kind, title, hint }: {
  state: CmsState; reload: () => void; purpose: 'WEB_LOGO' | 'PWA_ICON'; kind: 'web-logo' | 'pwa-icon'; title: string; hint: string;
}) {
  const selected = purpose === 'WEB_LOGO' ? state.webLogoAssetId : state.pwaIconAssetId;
  const assets = state.assets.filter((asset) => asset.purpose === purpose);
  const [error, setError] = useState<string | null>(null);

  async function choose(assetId: string | null): Promise<void> {
    setError(null);
    try {
      await setCmsWebArtwork(kind, state.revision, assetId);
      reload();
    } catch (caught) {
      setError(message(caught));
    }
  }

  return (
    <Card title={title}>
      <ul>
        {assets.map((asset) => (
          <li key={asset.id}>
            {asset.label} <AssetPreview asset={asset} />{' '}
            {asset.id === selected
              ? <Badge tone="success">In use</Badge>
              : <Button size="sm" variant="secondary" onClick={() => void choose(asset.id)}>Use</Button>}
          </li>
        ))}
      </ul>
      {selected ? <Button size="sm" variant="secondary" onClick={() => void choose(null)}>Use the bundled E-SET artwork</Button> : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <UploadForm purpose={purpose} onUploaded={reload} hint={hint} />
    </Card>
  );
}

function IntegrationsTab() {
  const resource = useApiResource<DropboxStatus>((signal) => getDropboxStatus(signal), []);
  const [error, setError] = useState<string | null>(null);
  const status = resource.data;

  async function run(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
      resource.reload();
    } catch (caught) {
      setError(message(caught));
    }
  }

  async function connect(): Promise<void> {
    setError(null);
    try {
      const { authorizationUrl } = await startDropboxConnect();
      // Only ever navigate to Dropbox's own authorization page.
      let origin = '';
      try { origin = new URL(authorizationUrl).origin; } catch { /* refused below */ }
      if (origin !== 'https://www.dropbox.com') {
        setError('Unexpected authorization address');
        return;
      }
      window.location.assign(authorizationUrl);
    } catch (caught) {
      setError(message(caught));
    }
  }

  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (!status) return <SkeletonRows />;
  return (
    <Card title="Permit Dropbox">
      <p className="muted">
        Permit&apos;s own Dropbox connection, independent of ESDMS. New files go to the active connection; existing files are always
        read from the connection that stored them. A connection with dependent files cannot be disconnected.
      </p>
      {!status.setupComplete ? <Alert tone="warning">Dropbox is not configured for this environment. Contact your operator.</Alert> : null}
      <ul>
        {status.connections.map((connection) => (
          <li key={connection.id}>
            {connection.accountLabel ?? 'Dropbox account'}{' '}
            <Badge tone={connection.status === 'connected' ? 'success' : connection.status === 'error' ? 'danger' : 'neutral'}>
              {connection.id === status.activeConnectionId ? 'Active' : connection.status}
            </Badge>{' '}
            <span className="muted">{connection.dependentFiles} file(s)</span>{' '}
            <Button size="sm" variant="secondary" onClick={() => void run(() => testDropboxConnection(connection.id))}>Test</Button>{' '}
            {connection.id === status.activeConnectionId
              ? <Button size="sm" variant="secondary" onClick={() => void run(() => deactivateDropbox(status.selectionRevision))}>Stop using for new files</Button>
              : <Button size="sm" variant="secondary" disabled={connection.status !== 'connected'}
                  onClick={() => void run(() => activateDropbox(status.selectionRevision, connection.id))}>Use for new files</Button>}{' '}
            <Button size="sm" variant="danger" disabled={connection.dependentFiles > 0 || connection.id === status.activeConnectionId}
              onClick={() => void run(() => disconnectDropbox(connection.revision, connection.id))}>Disconnect</Button>
          </li>
        ))}
      </ul>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button onClick={() => void connect()} disabled={!status.setupComplete}>Connect Dropbox</Button>
    </Card>
  );
}

function AuditTab() {
  const resource = useApiResource((signal) => listCmsAudit(signal), []);
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (!resource.data) return <SkeletonRows />;
  return (
    <Card title="CMS history">
      <ul>
        {resource.data.events.map((event) => (
          <li key={event.id}>
            <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time> - {event.eventType.replaceAll('_', ' ').toLowerCase()}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function CmsPage() {
  const { capabilities } = useCurrentUser();
  const resource = useApiResource<CmsState>((signal) => getCmsState(signal), [], { enabled: capabilities.canManageCms });
  const [tab, setTab] = useState('identity');

  if (!capabilities.canManageCms) {
    return <Alert tone="warning">You do not have access to the CMS.</Alert>;
  }
  const tabs = [
    { id: 'identity', label: 'Organization' },
    { id: 'pdf', label: 'PDF branding' },
    { id: 'web', label: 'Website and app icon' },
    ...(capabilities.canManageStorage ? [{ id: 'integrations', label: 'Integrations' }] : []),
    { id: 'audit', label: 'Audit' },
  ];
  const state = resource.data;
  return (
    <div className="stack">
      <PageHeader eyebrow="Administration" title="CMS" description="Permit branding, content and integrations." />
      <Tabs tabs={tabs} activeId={tab} onChange={setTab} label="CMS sections" />
      {resource.error ? <ErrorState error={resource.error} onRetry={resource.reload} /> : null}
      {!state && !resource.error ? <SkeletonRows /> : null}
      {state ? (
        <>
          <TabPanel id="identity" activeId={tab}><IdentityTab key={state.revision} state={state} reload={resource.reload} /></TabPanel>
          <TabPanel id="pdf" activeId={tab}><PdfLogosTab key={state.revision} state={state} reload={resource.reload} /></TabPanel>
          <TabPanel id="web" activeId={tab}>
            <div className="stack">
              <ArtworkSection state={state} reload={resource.reload} purpose="WEB_LOGO" kind="web-logo" title="Website header logo"
                hint="Shown in the header and on the sign-in page. Falls back to the bundled E-SET logo whenever it cannot be loaded." />
              <ArtworkSection state={state} reload={resource.reload} purpose="PWA_ICON" kind="pwa-icon" title="Favicon and app icon"
                hint="Square, at least 512 x 512 pixels. New installs use it; devices that already installed the app may keep their cached icon until it is refreshed or reinstalled." />
            </div>
          </TabPanel>
        </>
      ) : null}
      {capabilities.canManageStorage ? <TabPanel id="integrations" activeId={tab}><IntegrationsTab /></TabPanel> : null}
      <TabPanel id="audit" activeId={tab}><AuditTab /></TabPanel>
    </div>
  );
}
