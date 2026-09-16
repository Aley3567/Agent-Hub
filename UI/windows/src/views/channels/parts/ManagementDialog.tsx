import { t } from '../../../i18n';
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Field, Input, Select, Switch } from '../../../components';
import * as api from '../../../api';
import { errorText, useApp } from '../../../store';
import type { AppType, Channel, CredentialStatus, ImportPreview, ImportSelection, ProviderEditView, ProviderOutcome, ProviderSource } from '../../../types/contract';
import styles from './ManagementDialog.module.css';

export type ManagementMode = 'create' | 'edit' | 'delete' | 'import' | 'migrate';
export default function ManagementDialog({ mode, channel, onClose, onComplete }: {
  mode: ManagementMode; channel?: Channel; onClose(): void; onComplete(message: string): void;
}) {
  const refresh = useApp((state) => state.refresh);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appType, setAppType] = useState<AppType>(channel?.appType ?? 'claude');
  const [id, setId] = useState(channel?.id ?? '');
  const [name, setName] = useState(channel?.name ?? '');
  const [endpoint, setEndpoint] = useState('');
  const [model, setModel] = useState('');
  const [protocol, setProtocol] = useState('anthropic');
  const [secret, setSecret] = useState('');
  const [secretAction, setSecretAction] = useState(mode === 'create' ? 'replace' : 'keep');
  const [view, setView] = useState<ProviderEditView | null>(null);
  const [sourceKind, setSourceKind] = useState<ProviderSource['kind']>('cc_switch');
  const [sourcePath, setSourcePath] = useState('');
  const [profile, setProfile] = useState('');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [replace, setReplace] = useState(false);
  const [counts, setCounts] = useState<ImportSelection | null>(null);
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const planRef = useRef<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (planRef.current) void api.cancelImport(planRef.current).catch(() => {});
      planRef.current = null;
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (mode === 'edit' && channel) {
      setBusy(true);
      void api.providerEditView(channel.appType, channel.id).then((next) => {
        if (!active) return;
        setView(next); setModel(next.model ?? ''); setProtocol(next.provider.protocol);
      }).catch((err: unknown) => { if (active) setError(errorText(err)); })
        .finally(() => { if (active) setBusy(false); });
    }
    if (mode === 'migrate') void api.credentialStatus().then((next) => { if (active) setStatus(next); })
      .catch((err: unknown) => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, [mode, channel]);
  useEffect(() => {
    if (!preview) return;
    let active = true; setCounts(null);
    void api.selectImport(preview.planId, selected, replace).then((next) => { if (active) setCounts(next); })
      .catch((err: unknown) => { if (active) setError(errorText(err)); });
    return () => { active = false; };
  }, [preview, selected, replace]);
  function close(): void { if (!inFlight.current) { setSecret(''); onClose(); } }
  async function scan(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null); setCounts(null); setPreview(null);
    try {
      if (planRef.current) await api.cancelImport(planRef.current);
      planRef.current = null;
      const source: ProviderSource = sourceKind === 'codex'
        ? { kind: 'codex', config: sourcePath, auth: '', profile: profile || null }
        : { kind: sourceKind, path: sourcePath };
      const next = await api.previewImport(source);
      if (!mounted.current) { await api.cancelImport(next.planId); return; }
      planRef.current = next.planId; setPreview(next);
      setSelected(next.candidates.filter((c) => !c.blockedReason).map((c) => c.candidateId));
    } catch (err) { setError(errorText(err)); } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  function summary(result: ProviderOutcome): string {
    return t("新增 {0}，更新 {1}，保留 {2}{3}", [result.added, result.updated, result.skipped, result.pendingCleanup ? t("；待清理凭证 {0}", [result.pendingCleanup]) : '']);
  }
  async function submit(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError(null);
    try {
      let message: string;
      if (mode === 'import') {
        if (!preview || !counts) return;
        const result = await api.applyImport(preview.planId, selected, replace);
        planRef.current = null; message = summary(result);
      } else if (mode === 'migrate') {
        const result = await api.migrateCredentials();
        message = `${summary(result.applied)}${result.storageCleanupPending ? t("；本地存储清理未完成，可再次迁移重试") : ''}`;
      } else if (mode === 'delete' && channel) {
        const result = await api.removeProvider(channel.appType, channel.id);
        if (result.blockers.length) { setError(t("渠道仍被引用，请先解除：\n{0}", [result.blockers.join('\n')])); return; }
        message = t("已删除 {0} 个渠道{1}", [result.removed, result.pendingCleanup ? t("；系统凭证待清理") : '']);
      } else {
        if (!id.trim() || !name.trim()) { setError(t("请填写稳定 ID 和名称。")); return; }
        if (mode === 'create' && (!endpoint.trim() || !model.trim() || !secret)) { setError(t("请填写 API 地址、模型和 API key。")); return; }
        if (secretAction === 'replace' && !secret) { setError(t("请填写新 API key。")); return; }
        const result = await api.saveProvider({ appType, id, name,
          expectedRevision: view?.revision ?? null,
          ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
          ...(model !== (view?.model ?? '') || mode === 'create' ? { model } : {}),
          ...(protocol !== view?.provider.protocol ? { protocol } : {}),
          ...(secretAction === 'replace' ? { secret } : {}), clearSecret: secretAction === 'clear',
        });
        setSecret(''); message = summary(result);
      }
      await Promise.all([refresh('channels'), refresh('hubs'), refresh('pools')]);
      onComplete(message); onClose();
    } catch (err) {
      setError(errorText(err));
      if (mode === 'import') { planRef.current = null; setPreview(null); setCounts(null); }
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  const titles = { create: t("新增渠道"), edit: t("编辑渠道"), delete: t("删除渠道"), import: t("导入渠道"), migrate: t("迁移凭证") };
  const disabled = busy || (mode === 'edit' && !view) || (mode === 'import' && (!counts || !selected.length)) || (mode === 'migrate' && !status);
  return <Dialog open title={titles[mode]} onClose={close} closeOnOverlay={!busy} footer={<>
    <Button disabled={busy} onClick={close}>{t("取消")}</Button>
    <Button variant={mode === 'delete' ? 'danger' : 'primary'} loading={busy} disabled={disabled} onClick={() => void submit()}>{mode === 'delete' ? t("确认删除") : mode === 'migrate' ? t("确认迁移") : mode === 'import' ? t("确认导入") : t("保存")}</Button>
  </>}>
    <div className={styles.form}>
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      {mode === 'create' || mode === 'edit' ? <>
        <Field label={t("应用")} htmlFor="provider-app"><Select id="provider-app" value={appType} disabled={mode === 'edit' || busy} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} onChange={(e) => { const app = e.target.value as AppType; setAppType(app); setProtocol(app === 'codex' ? 'openai_responses' : 'anthropic'); }} /></Field>
        <Field label={t("稳定 ID")} htmlFor="provider-id"><Input id="provider-id" value={id} disabled={mode === 'edit' || busy} onChange={(e) => setId(e.target.value)} /></Field>
        <Field label={t("名称")} htmlFor="provider-name"><Input id="provider-name" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t("API 地址")} htmlFor="provider-endpoint" hint={view ? t("留空保留当前地址（{0}）", [view.provider.endpoint ?? t("未配置")]) : undefined}><Input id="provider-endpoint" value={endpoint} disabled={busy} placeholder="https://api.example.com" onChange={(e) => setEndpoint(e.target.value)} /></Field>
        <Field label={t("协议")} htmlFor="provider-protocol"><Select id="provider-protocol" value={protocol} disabled={busy || appType === 'codex'} options={['anthropic', 'openai_chat', 'openai_responses'].map((value) => ({ value, label: value }))} onChange={(e) => setProtocol(e.target.value)} /></Field>
        <Field label={t("默认模型")} htmlFor="provider-model"><Input id="provider-model" value={model} disabled={busy} onChange={(e) => setModel(e.target.value)} /></Field>
        {mode === 'edit' ? <Field label={t("凭证操作")} htmlFor="provider-secret-action"><Select id="provider-secret-action" value={secretAction} disabled={busy} options={[{ value: 'keep', label: t("保留现有凭证") }, { value: 'replace', label: t("替换 API key") }, { value: 'clear', label: t("清除 API 凭证") }]} onChange={(e) => { setSecretAction(e.target.value); setSecret(''); }} /></Field> : null}
        {secretAction === 'replace' ? <Field label="API key" htmlFor="provider-secret"><Input id="provider-secret" type="password" autoComplete="new-password" value={secret} disabled={busy} onChange={(e) => setSecret(e.target.value)} /></Field> : null}
      </> : null}
      {mode === 'import' ? <>
        <Field label={t("来源")} htmlFor="provider-source"><Select id="provider-source" value={sourceKind} disabled={busy || preview !== null} options={[{ value: 'cc_switch', label: 'CC Switch' }, { value: 'claude', label: t("Claude 用户配置") }, { value: 'codex', label: t("Codex 用户配置") }, { value: 'json', label: t("version:1 JSON 文件") }]} onChange={(e) => setSourceKind(e.target.value as ProviderSource['kind'])} /></Field>
        <Field label={t("来源文件")} htmlFor="provider-source-path" hint={sourceKind === 'json' ? t("填写 JSON 文件完整路径") : t("留空使用该应用的用户配置路径")}><Input id="provider-source-path" value={sourcePath} disabled={busy || preview !== null} onChange={(e) => setSourcePath(e.target.value)} /></Field>
        {sourceKind === 'codex' ? <Field label={t("Profile（可选）")} htmlFor="provider-profile"><Input id="provider-profile" value={profile} disabled={busy || preview !== null} onChange={(e) => setProfile(e.target.value)} /></Field> : null}
        <Button disabled={busy || (sourceKind === 'json' && !sourcePath)} onClick={() => void scan()}>{t("扫描并预览")}</Button>
        {preview ? <div className={styles.candidates}>
          {preview.blocked.map((reason, i) => <p key={`${reason}-${i}`}>{t("不可导入：")}{reason}</p>)}
          {!preview.candidates.length ? <p>{t("此来源没有可导入渠道。")}</p> : null}
          {preview.candidates.map((candidate) => <label className={styles.candidate} key={candidate.candidateId}>
            <input type="checkbox" disabled={busy || candidate.blockedReason !== null} checked={selected.includes(candidate.candidateId)} onChange={(e) => { setCounts(null); setSelected((current) => e.target.checked ? [...current, candidate.candidateId] : current.filter((id) => id !== candidate.candidateId)); }} />
            <span>{candidate.name} · {candidate.appType}<small>{candidate.endpoint ?? t("未配置地址")} · {candidate.blockedReason ?? (candidate.conflict ? t("已有同 ID") : t("新增"))}</small></span>
          </label>)}
          <Switch label={t("覆盖所选已有渠道")} checked={replace} disabled={busy} onChange={(value) => { setCounts(null); setReplace(value); }} />
          {counts ? <p>{t("将新增 {0}，更新 {1}，保留 {2}", [counts.added, counts.updated, counts.skipped])}</p> : null}
        </div> : null}
      </> : null}
      {mode === 'delete' ? <p>{t("删除 {0}（{1}）？已有会话继续运行；仍被 Hub 或账号池引用时将阻止删除。", [channel?.name, channel?.appType])}</p> : null}
      {mode === 'migrate' ? <><p>{t("将 Hub 库的旧凭证移入系统凭证库。启动仍可能使用受限临时认证文件，历史备份保留原样。")}</p><p>{status ? t("待迁移 {0}，已引用 {1}，待清理 {2}", [status.legacy, status.referenced, status.pendingCleanup]) : t("正在检查凭证状态…")}</p></> : null}
    </div>
  </Dialog>;
}
