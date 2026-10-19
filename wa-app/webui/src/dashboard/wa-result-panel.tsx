import type { WaWorkflowResponse } from './wa-api';
import { accountFlowLabel, accountReasonLabel, booleanLabel, methodStateLabel, oldDeviceLabel, smsLabel } from './wa-result-labels';
import { metaItems, outcomeMeta, waProbeStatus, type BadgeVariant, type ResultTone, type WaProbeStatus } from './wa-result-model';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';

export function WaResultPanel({ title, phone, result, loading, showMethods = true }: { title: string; phone?: string; result?: WaWorkflowResponse | null; loading?: boolean; showMethods?: boolean }) {
  const status = waProbeStatus(result);
  const outcome = outcomeMeta(status, result, loading);
  const methods = showMethods ? status.methodStatuses.map((method) => ({ key: method.key, label: method.label, state: methodStateLabel(method.available, method.cooldownSeconds) })) : [];
  const meta = metaItems(status, result, showMethods);
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-xs font-medium">{title}</span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{phone || '-'}</span>
        </div>
        <Badge variant={badgeVariant(outcome.variant)}>{outcome.label}</Badge>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {waMetrics(status, showMethods).map((item) => <MetricChip key={item.label} {...item} />)}
      </div>
      {(methods.length > 0 || meta.length > 0) && (
        <Card className="grid grid-cols-2 gap-x-3 gap-y-1 rounded-md bg-background/70 px-2.5 py-1.5 text-[11px] shadow-none">
          {methods.map((method) => <GridMeta key={method.key} label={method.label} value={method.state} />)}
          {meta.map((item) => <GridMeta key={item.label} label={item.label} value={item.value} tone={item.tone} />)}
        </Card>
      )}
    </div>
  );
}

function MetricChip({ label, value, tone }: { label: string; value: string; tone: ResultTone }) {
  return <Badge variant="outline" className={`gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-normal ${toneClass(tone, true)}`}><span className="text-muted-foreground">{label}</span><span className="font-semibold">{value}</span></Badge>;
}

function GridMeta({ label, value, tone = 'idle' }: { label: string; value: string; tone?: ResultTone }) {
  return <div className="min-w-0"><span className="mr-1 text-muted-foreground">{label}</span><span className={`break-words font-medium ${toneClass(tone)}`}>{value}</span></div>;
}

function badgeVariant(variant: BadgeVariant) {
  return variant === 'default' ? 'default' : variant;
}

function toneClass(tone: ResultTone = 'idle', chip = false) {
  if (chip) {
    if (tone === 'ok') return 'border-primary/30 bg-primary/5 text-primary';
    if (tone === 'bad') return 'border-destructive/30 bg-destructive/5 text-destructive';
    if (tone === 'warn') return 'border-amber-500/30 bg-amber-500/5 text-amber-700';
    return 'bg-muted/30 text-muted-foreground';
  }
  if (tone === 'ok') return 'text-primary';
  if (tone === 'bad') return 'text-destructive';
  if (tone === 'warn') return 'text-amber-600';
  return 'text-muted-foreground';
}

function waMetrics(status: WaProbeStatus, showSms: boolean): Array<{ label: string; value: string; tone: ResultTone }> {
  if (status.blocked === true) {
    return [
      { label: '封禁', value: '是', tone: 'bad' },
      { label: '请求', value: status.requestFailed ? '被拒绝' : '异常', tone: 'bad' },
      { label: '原因', value: accountReasonLabel(status.failureReason, status.accountRawReason) || '号码被 WA 拒绝或封禁', tone: 'bad' },
    ];
  }
  if (status.accountFlow === 'rate_limited') {
    return [
      { label: '请求', value: '冷却中', tone: 'warn' },
      { label: '阶段', value: accountFlowLabel(status.accountFlow), tone: 'warn' },
      { label: '原因', value: accountReasonLabel(status.accountRawReason, status.failureReason, status.accountRawStatus) || '请求过于频繁，请稍后再试', tone: 'warn' },
    ];
  }
  if (status.requestFailed) {
    return [
      { label: '请求', value: '失败', tone: 'bad' },
      { label: '阶段', value: accountFlowLabel(status.accountFlow) || '状态待确认', tone: 'bad' },
      { label: '原因', value: accountReasonLabel(status.accountRawReason, status.failureReason, status.accountRawStatus) || '请求被 WA 拒绝', tone: 'bad' },
    ];
  }
  const items = [
    { label: '旧设备', value: oldDeviceLabel(status.registered, status.accountFlow), tone: oldDeviceTone(status) },
    { label: '封禁', value: booleanLabel(status.blocked), tone: booleanTone(status.blocked) },
  ];
  if (showSms) items.splice(1, 0, { label: 'SMS', value: smsLabel(status.smsAvailable, status.smsWaitSeconds), tone: smsTone(status) });
  return items;
}

function oldDeviceTone(status: WaProbeStatus): ResultTone {
  if (status.registered === true || status.accountFlow === 'registered') return 'warn';
  if (status.accountFlow === 'blocked') return 'bad';
  return 'idle';
}
function smsTone(status: WaProbeStatus): ResultTone {
  if (status.smsAvailable === true && !status.smsWaitSeconds) return 'ok';
  if (status.smsAvailable === false || Boolean(status.smsWaitSeconds)) return 'warn';
  return 'idle';
}
function booleanTone(value?: boolean): ResultTone {
  if (value === true) return 'bad';
  if (value === false) return 'ok';
  return 'idle';
}
