import { useEffect, useId, useRef, useState } from "react";
import { useTranslation, type Translate } from "../../i18n";
import {
  isValidRemoteHostId,
  remoteWorkspaceId,
  type RemoteHostConfig,
  type RemoteHostState,
  type RemoteHostTestResult,
} from "../../../contracts/remote-hosts";
import { trapDialogFocus } from "../../ui/dialog-focus";
import { SettingsGroup } from "./settings-utils";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A host id from its name: lowercase letters, digits and dashes, unique among `taken`. */
export function hostIdFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50) || "host";
  let id = base;
  for (let suffix = 2; taken.has(id); suffix += 1) {
    id = `${base}-${suffix}`;
  }
  return id;
}

function statusText(state: RemoteHostState, t: Translate): string {
  switch (state.status) {
    case "connected":
      return state.hostname && state.hostVersion
        ? t("settings.remoteHosts.status.connectedTo", {
            hostname: state.hostname,
            version: state.hostVersion,
          })
        : t("settings.remoteHosts.status.connected");
    case "connecting":
      return t("settings.remoteHosts.status.connecting");
    case "installing":
      return t("settings.remoteHosts.status.installing");
    case "disconnected":
      return t("settings.remoteHosts.status.disconnected");
    case "error":
      return t("settings.remoteHosts.status.error");
  }
}

type Dialog =
  | { readonly kind: "closed" }
  | { readonly kind: "host"; readonly original?: RemoteHostConfig }
  | { readonly kind: "folder"; readonly host: RemoteHostConfig };

export function SettingsRemoteHostsSection() {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<readonly RemoteHostState[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [dialog, setDialog] = useState<Dialog>({ kind: "closed" });

  useEffect(() => {
    const api = window.piApp;
    if (!api) {
      return;
    }
    let cancelled = false;
    api.listRemoteHosts().then(
      (list) => {
        if (!cancelled) setHosts(list);
      },
      (loadError: unknown) => {
        if (!cancelled)
          setError(t("settings.remoteHosts.loadFailed", { message: errorText(loadError) }));
      },
    );
    const stop = api.onRemoteHostsChanged((list) => setHosts(list));
    return () => {
      cancelled = true;
      stop();
    };
  }, [t]);

  const act = (action: () => Promise<unknown>) => {
    setError(undefined);
    action().catch((actionError: unknown) => setError(errorText(actionError)));
  };

  return (
    <>
      <SettingsGroup
        title={t("settings.remoteHosts.group")}
        description={t("settings.remoteHosts.groupDescription")}
      >
        {error ? (
          <div className="settings-row">
            <span className="settings-row__description settings-warning">{error}</span>
          </div>
        ) : null}
        {hosts.length === 0 ? (
          <div className="settings-row">
            <span className="settings-row__description">{t("settings.remoteHosts.empty")}</span>
          </div>
        ) : (
          hosts.map((host) => (
            <div
              className="settings-row"
              data-remote-host={host.config.id}
              data-remote-status={host.status}
              key={host.config.id}
            >
              <div className="settings-row__label">
                <div className="settings-row__title">{host.config.label}</div>
                <div className="settings-row__description">
                  {host.config.destination} · {statusText(host, t)}
                </div>
                {host.message && host.status !== "connected" ? (
                  <div
                    className={`settings-row__description${host.status === "error" ? " settings-warning" : ""}`}
                  >
                    {host.message}
                  </div>
                ) : host.message ? (
                  <div className="settings-row__description">{host.message}</div>
                ) : null}
              </div>
              <div className="settings-row__control">
                <button
                  className="button button--secondary"
                  disabled={host.status !== "connected"}
                  type="button"
                  onClick={() => setDialog({ kind: "folder", host: host.config })}
                >
                  {t("settings.remoteHosts.addFolder")}
                </button>
                {host.status === "connected" ? (
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          t("settings.remoteHosts.restartConfirm", { name: host.config.label }),
                        )
                      ) {
                        act(() => window.piApp!.restartRemoteHost(host.config.id));
                      }
                    }}
                  >
                    {t("settings.remoteHosts.restart")}
                  </button>
                ) : (
                  <button
                    className="button button--secondary"
                    type="button"
                    onClick={() => act(() => window.piApp!.reconnectRemoteHost(host.config.id))}
                  >
                    {t("settings.remoteHosts.reconnect")}
                  </button>
                )}
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => setDialog({ kind: "host", original: host.config })}
                >
                  {t("settings.common.edit")}
                </button>
                <button
                  className="button button--secondary"
                  type="button"
                  onClick={() => {
                    if (
                      window.confirm(
                        t("settings.remoteHosts.removeConfirm", { name: host.config.label }),
                      )
                    ) {
                      act(() => window.piApp!.removeRemoteHost(host.config.id));
                    }
                  }}
                >
                  {t("settings.common.remove")}
                </button>
              </div>
            </div>
          ))
        )}
        <div className="settings-row">
          <div className="settings-row__label">
            <div className="settings-row__title">{t("settings.remoteHosts.add")}</div>
            <div className="settings-row__description">
              {t("settings.remoteHosts.addDescription")}
            </div>
          </div>
          <div className="settings-row__control">
            <button className="button" type="button" onClick={() => setDialog({ kind: "host" })}>
              {t("settings.remoteHosts.add")}
            </button>
          </div>
        </div>
      </SettingsGroup>

      {dialog.kind === "host" ? (
        <RemoteHostDialog
          {...(dialog.original ? { original: dialog.original } : {})}
          takenIds={new Set(hosts.map((host) => host.config.id))}
          onClose={() => setDialog({ kind: "closed" })}
        />
      ) : null}
      {dialog.kind === "folder" ? (
        <RemoteFolderDialog host={dialog.host} onClose={() => setDialog({ kind: "closed" })} />
      ) : null}
    </>
  );
}

function DialogFrame({
  title,
  body,
  busy,
  onClose,
  children,
  testId,
}: {
  readonly title: string;
  readonly body: string;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
  readonly testId: string;
}) {
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="extension-dialog-backdrop">
      <div
        aria-labelledby={titleId}
        aria-modal="true"
        className="extension-dialog custom-endpoint-dialog"
        data-testid={testId}
        ref={ref}
        role="dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          } else if (event.key === "Tab") {
            trapDialogFocus(event, ref.current);
          }
        }}
      >
        <div className="custom-endpoint-dialog__content">
          <div className="extension-dialog__title" id={titleId}>
            {title}
          </div>
          <p className="extension-dialog__body">{body}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  disabled,
  autoFocus,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly autoFocus?: boolean;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        aria-label={label}
        autoFocus={autoFocus}
        className="settings-search"
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="settings-row__description">{hint}</span> : null}
    </label>
  );
}

function RemoteHostDialog({
  original,
  takenIds,
  onClose,
}: {
  readonly original?: RemoteHostConfig;
  readonly takenIds: ReadonlySet<string>;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState(original?.label ?? "");
  const [destination, setDestination] = useState(original?.destination ?? "");
  const [port, setPort] = useState(original?.port ? String(original.port) : "");
  const [identityFile, setIdentityFile] = useState(original?.identityFile ?? "");
  const [nodePath, setNodePath] = useState(original?.nodePath ?? "");
  const [hostHome, setHostHome] = useState(original?.hostHome ?? "");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();
  const [test, setTest] = useState<RemoteHostTestResult | undefined>();

  const build = (): RemoteHostConfig | undefined => {
    if (!label.trim() || !destination.trim()) {
      setFormError(t("settings.remoteHosts.required"));
      return undefined;
    }
    const portNumber = port.trim() ? Number(port.trim()) : undefined;
    if (
      portNumber !== undefined &&
      (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535)
    ) {
      setFormError(t("settings.remoteHosts.invalidPort"));
      return undefined;
    }
    const id = original?.id ?? hostIdFromLabel(label, takenIds);
    if (!isValidRemoteHostId(id)) {
      setFormError(t("settings.remoteHosts.idInUse", { name: label }));
      return undefined;
    }
    return {
      id,
      label: label.trim(),
      destination: destination.trim(),
      ...(portNumber ? { port: portNumber } : {}),
      ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}),
      ...(nodePath.trim() ? { nodePath: nodePath.trim() } : {}),
      ...(hostHome.trim() ? { hostHome: hostHome.trim() } : {}),
    };
  };

  const run = async (action: (config: RemoteHostConfig) => Promise<void>) => {
    const config = build();
    if (!config || !window.piApp) {
      return;
    }
    setBusy(true);
    setFormError(undefined);
    try {
      await action(config);
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      body={t("settings.remoteHosts.dialog.body")}
      busy={busy}
      testId="remote-host-dialog"
      title={
        original
          ? t("settings.remoteHosts.dialog.editTitle")
          : t("settings.remoteHosts.dialog.addTitle")
      }
      onClose={onClose}
    >
      <TextField
        autoFocus
        disabled={busy}
        label={t("settings.remoteHosts.field.label")}
        value={label}
        onChange={setLabel}
      />
      <TextField
        disabled={busy}
        hint={t("settings.remoteHosts.field.destinationHint")}
        label={t("settings.remoteHosts.field.destination")}
        placeholder="devbox"
        value={destination}
        onChange={setDestination}
      />
      <TextField
        disabled={busy}
        label={t("settings.remoteHosts.field.port")}
        placeholder="22"
        value={port}
        onChange={setPort}
      />
      <TextField
        disabled={busy}
        label={t("settings.remoteHosts.field.identityFile")}
        placeholder="~/.ssh/id_ed25519"
        value={identityFile}
        onChange={setIdentityFile}
      />
      <TextField
        disabled={busy}
        hint={t("settings.remoteHosts.field.nodePathHint")}
        label={t("settings.remoteHosts.field.nodePath")}
        placeholder="/usr/bin/node"
        value={nodePath}
        onChange={setNodePath}
      />
      <TextField
        disabled={busy}
        label={t("settings.remoteHosts.field.hostHome")}
        placeholder="~/.pi-gui-host"
        value={hostHome}
        onChange={setHostHome}
      />
      {test ? (
        <p
          className={`settings-row__description${test.ok ? "" : " settings-warning"}`}
          data-testid="remote-host-test-result"
        >
          {test.ok
            ? t("settings.remoteHosts.testOk", {
                nodeVersion: test.nodeVersion,
                home: test.home,
                installed: test.installed
                  ? t("settings.remoteHosts.testInstalled")
                  : t("settings.remoteHosts.testNotInstalled"),
              })
            : test.message}
        </p>
      ) : null}
      {formError ? <p className="settings-row__description settings-warning">{formError}</p> : null}
      <div className="extension-dialog__actions">
        <button
          className="button button--secondary"
          disabled={busy}
          type="button"
          onClick={() => {
            run(async (config) => {
              setTest(undefined);
              setTest(await window.piApp!.testRemoteHost(config));
            }).catch(() => undefined);
          }}
        >
          {busy ? t("settings.remoteHosts.testing") : t("settings.remoteHosts.test")}
        </button>
        <button
          className="button button--secondary"
          disabled={busy}
          type="button"
          onClick={onClose}
        >
          {t("settings.remoteHosts.cancel")}
        </button>
        <button
          className="button"
          disabled={busy}
          type="button"
          onClick={() => {
            run(async (config) => {
              await window.piApp!.saveRemoteHost(config);
              onClose();
            }).catch(() => undefined);
          }}
        >
          {t("settings.remoteHosts.save")}
        </button>
      </div>
    </DialogFrame>
  );
}

function RemoteFolderDialog({
  host,
  onClose,
}: {
  readonly host: RemoteHostConfig;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | undefined>();

  const add = async () => {
    const trimmed = path.trim().replace(/\/+$/, "") || "/";
    if (!trimmed.startsWith("/") || !window.piApp) {
      setFormError(t("settings.remoteHosts.folderInvalid"));
      return;
    }
    setBusy(true);
    setFormError(undefined);
    try {
      const state = await window.piApp.addWorkspacePath(remoteWorkspaceId(host.id, trimmed));
      if (state.lastError) {
        setFormError(state.lastError);
        return;
      }
      onClose();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogFrame
      body={t("settings.remoteHosts.folderBody")}
      busy={busy}
      testId="remote-folder-dialog"
      title={t("settings.remoteHosts.folderTitle", { name: host.label })}
      onClose={onClose}
    >
      <TextField
        autoFocus
        disabled={busy}
        label={t("settings.remoteHosts.folderPath")}
        placeholder="/home/you/project"
        value={path}
        onChange={setPath}
      />
      {formError ? <p className="settings-row__description settings-warning">{formError}</p> : null}
      <div className="extension-dialog__actions">
        <button
          className="button button--secondary"
          disabled={busy}
          type="button"
          onClick={onClose}
        >
          {t("settings.remoteHosts.cancel")}
        </button>
        <button
          className="button"
          disabled={busy}
          type="button"
          onClick={() => {
            add().catch(() => undefined);
          }}
        >
          {t("settings.remoteHosts.folderAdd")}
        </button>
      </div>
    </DialogFrame>
  );
}
