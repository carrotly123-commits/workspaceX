import type { WAAccount } from '../proto/byte/v/forge/waapp/v1/profile';
import { waAccountProfilePictureURL, waAccountTitle } from './wa-api';
import { WhatsAppIcon } from './wa-brand-icon';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export function WaAccountAvatar({ account, version, size = 'md' }: { account: WAAccount; version: string; size?: 'xs' | 'sm' | 'md' | 'lg' }) {
  const src = waAccountProfilePictureURL(account, version || 'latest');
  const sizeClass = size === 'xs' ? 'size-8' : size === 'sm' ? 'size-9' : size === 'lg' ? 'size-12' : 'size-10';
  const iconClass = size === 'xs' ? 'size-5!' : size === 'sm' ? 'size-6!' : size === 'lg' ? 'size-8!' : 'size-7!';
  const title = waAccountTitle(account);
  return (
    <Avatar className={sizeClass}>
      {src ? <AvatarImage key={src} src={src} alt={title} /> : null}
      <AvatarFallback className="bg-emerald-50">
        <WhatsAppIcon className={iconClass} title={title} />
      </AvatarFallback>
    </Avatar>
  );
}
