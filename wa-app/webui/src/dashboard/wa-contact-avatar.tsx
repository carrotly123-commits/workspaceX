import type { WaContact } from './wa-chat-model';
import { WhatsAppIcon } from './wa-brand-icon';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

type ContactAvatarSize = 'sm' | 'md';

export function WaContactAvatar({ contact, size = 'md' }: { contact?: WaContact; size?: ContactAvatarSize }) {
  const pictureURL = contact?.profilePictureURL || '';
  const sizeClass = size === 'sm' ? 'size-9' : 'size-10';
  const iconClass = size === 'sm' ? 'size-6' : 'size-7';
  const title = contact?.title || '联系人';
  return (
    <Avatar className={sizeClass}>
      {pictureURL ? <AvatarImage src={pictureURL} alt={title} loading="lazy" /> : null}
      <AvatarFallback className="bg-emerald-50">
        <WhatsAppIcon className={iconClass} title={title} />
      </AvatarFallback>
    </Avatar>
  );
}
