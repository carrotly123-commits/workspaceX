import { Field, FieldLabel } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { WaPlayIntegrityAPIStatus } from './wa-dashboard-config';
import { normalizeWaIntegrityMode, type WaIntegrityMode } from './wa-integrity';

type Props = {
  available: boolean;
  disabled?: boolean;
  status?: WaPlayIntegrityAPIStatus | null;
  statusLoading?: boolean;
  value: WaIntegrityMode;
  onChange: (value: WaIntegrityMode) => void;
};

export function WaIntegrityModeSelect({ available, disabled, status, statusLoading, value, onChange }: Props) {
  if (!available) return null;
  const showStatus = value === 'play_integrity_api';
  return (
    <Field>
      <FieldLabel>GPIA 来源</FieldLabel>
      <Select value={value} onValueChange={(next) => onChange(normalizeWaIntegrityMode(next))} disabled={disabled}>
        <SelectTrigger className="w-full">
          <SelectValue placeholder="选择 GPIA 来源" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="error_code">error_code（默认）</SelectItem>
          <SelectItem value="play_integrity_api">Play Integrity API</SelectItem>
        </SelectContent>
      </Select>
      {showStatus ? (
        <p className="px-1 text-[11px] text-muted-foreground">{playIntegrityStatusLabel(status, Boolean(statusLoading))}</p>
      ) : (
        <p className="px-1 text-[11px] text-muted-foreground">仅后端配置 Play Integrity API 地址和 Token 后显示；Token 不会下发到前端。</p>
      )}
    </Field>
  );
}

function playIntegrityStatusLabel(status: WaPlayIntegrityAPIStatus | null | undefined, loading: boolean) {
  if (loading && !status) return 'Play Integrity API：正在拉取 VM 状态…';
  if (!status) return 'Play Integrity API：未拉取 VM 状态';
  if (!status.configured) return 'Play Integrity API：未配置';
  if (!status.available) return 'Play Integrity API：不可用';
  const vm = status.vm;
  if (!vm?.enabled) return 'Play Integrity API：已连接，DG VM 未启用';
  const state = vm.state || 'unknown';
  const prewarm = vm.prewarmCompleted ? '已预热' : vm.prewarmStarted ? '预热中' : '未预热';
  const busy = vm.busy ? '忙' : '空闲';
  const requests = typeof vm.successCount === 'number' ? `成功 ${vm.successCount}/${vm.requestCount ?? 0}` : '';
  const warmup = typeof vm.prewarmElapsedMs === 'number' && vm.prewarmElapsedMs > 0 ? `预热 ${Math.round(vm.prewarmElapsedMs / 1000)}s` : '';
  return ['Play Integrity API VM', state, prewarm, busy, requests, warmup].filter(Boolean).join(' · ');
}
