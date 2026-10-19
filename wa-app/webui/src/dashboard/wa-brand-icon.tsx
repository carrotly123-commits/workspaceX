export function WhatsAppIcon({ className = 'size-5', title = 'WhatsApp' }: { className?: string; title?: string }) {
  return <img className={className} src="/whatsapp.svg" alt={title} draggable={false} />;
}
