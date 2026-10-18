import { useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';

type Props = {
  pendingCount: number;
  busy: boolean;
  onCleanup: () => Promise<void>;
};

export function WaPendingCleanupButton({ pendingCount, busy, onCleanup }: Props) {
  const [open, setOpen] = useState(false);
  async function cleanup() {
    try {
      await onCleanup();
      setOpen(false);
    } catch {
      // mutation owner displays the toast
    }
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8 group-data-[collapsible=icon]:hidden" disabled={busy} title="清理等待验证码账号" aria-label="清理等待验证码账号">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 size={16} />}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>清理等待验证码账号</DialogTitle>
          <DialogDescription>将删除所有状态为“等待验证码”的账号及其注册临时数据。当前已加载 {pendingCount} 个等待验证码账号。</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild><Button variant="outline" disabled={busy}>取消</Button></DialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void cleanup()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            确认清理
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
