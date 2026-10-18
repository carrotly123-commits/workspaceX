import { Cpu, Fingerprint, Loader2, Smartphone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ClientProfile, DeviceFingerprint } from '../proto/byte/v/forge/waapp/v1/profile';
import { clientProfileStatusView } from './wa-result-labels';
import { Badge } from '@/components/ui/badge';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';

export function WaDeviceFingerprintPanel({ profiles, loading }: { profiles: ClientProfile[]; loading: boolean }) {
  if (loading) return <p className="inline-flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />加载设备指纹...</p>;
  if (profiles.length === 0) return <p className="text-sm text-muted-foreground">暂无客户端 Profile。</p>;
  return <div className="grid gap-6">{profiles.map((profile) => <ProfileBlock key={profile.client_profile_id} profile={profile} />)}</div>;
}

function ProfileBlock({ profile }: { profile: ClientProfile }) {
  const fp = profile.device_fingerprint;
  const status = clientProfileStatusView(profile.status);
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm">{deviceTitle(fp)}</CardTitle>
        <CardDescription className="truncate font-mono text-xs">{profile.client_profile_id}</CardDescription>
        <CardAction><Badge variant={status.variant}>{status.label}</Badge></CardAction>
      </CardHeader>
      <CardContent>{fp ? <FingerprintGrid fingerprint={fp} /> : <p className="text-sm text-muted-foreground">没有可展示的设备指纹。</p>}</CardContent>
    </Card>
  );
}

function FingerprintGrid({ fingerprint }: { fingerprint: DeviceFingerprint }) {
  const rows: Array<{ label: string; value: string; icon: LucideIcon }> = [
    { label: '指纹 ID', value: fingerprint.fingerprint_id, icon: Fingerprint },
    { label: 'FDID', value: fingerprint.fdid, icon: Fingerprint },
    { label: 'Android', value: fingerprint.android_version, icon: Smartphone },
    { label: 'RAM / Radio', value: [ramLabel(fingerprint.device_ram_gib), radioLabel(fingerprint.network_radio_type)].filter(Boolean).join(' / '), icon: Cpu },
    { label: 'MCC/MNC', value: pairLabel(fingerprint.mcc, fingerprint.mnc), icon: Smartphone },
    { label: 'SIM MCC/MNC', value: pairLabel(fingerprint.sim_mcc, fingerprint.sim_mnc), icon: Smartphone },
    { label: 'Phone Hash', value: fingerprint.phone_sha256_prefix ? `${fingerprint.phone_sha256_prefix}...` : '', icon: Fingerprint },
    { label: '生成时间', value: formatTime(fingerprint.created_at), icon: Smartphone },
  ];
  return (
    <Table>
      <TableBody>
        {rows.map(({ label, value, icon: Icon }) => (
          <TableRow className="hover:bg-transparent" key={label}>
            <TableCell className="w-36 text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 text-xs"><Icon size={13} />{label}</span>
            </TableCell>
            <TableCell className="max-w-0 truncate font-mono text-xs">{value || '-'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function deviceTitle(fingerprint?: DeviceFingerprint) { return fingerprint ? [fingerprint.device_vendor, fingerprint.device_model].filter(Boolean).join(' ') || '未知设备' : '未知设备'; }
function pairLabel(a?: string, b?: string) { return [a, b].filter(Boolean).join('/'); }
function ramLabel(value?: string) { return value ? `${value} GiB` : ''; }
function radioLabel(value?: string) { const labels: Record<string, string> = { '1': 'GPRS', '2': 'EDGE', '3': 'UMTS', '9': 'HSDPA', '13': 'LTE', '20': 'NR' }; return value ? labels[value] || value : ''; }
function formatTime(value?: string) { if (!value) return ''; const time = new Date(value); return Number.isNaN(time.getTime()) ? value : time.toLocaleString(); }
