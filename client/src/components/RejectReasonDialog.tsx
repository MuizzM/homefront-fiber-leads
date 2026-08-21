import { useState, useEffect } from "react";
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogFooter,
  AlertDialogTitle, AlertDialogDescription, AlertDialogCancel, AlertDialogAction,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// A reason-capturing confirm for a money-affecting reject/send-back that writes
// a permanent audit reason. Replaces window.prompt (a native, unstyled, focus-
// unmanaged dialog inconsistent with the app's Radix dialogs) with an
// AlertDialog whose destructive action is disabled until a reason is entered.
export function RejectReasonDialog({
  open, onOpenChange, title, description, label = "Reason", placeholder = "Add a reason",
  confirmLabel = "Send back", busy = false, onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  label?: string;
  placeholder?: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  useEffect(() => { if (open) setReason(""); }, [open]);
  const canConfirm = reason.trim().length > 0 && !busy;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="reject-reason">{label}</Label>
          <Input
            id="reject-reason"
            value={reason}
            onChange={e => setReason(e.target.value)}
            placeholder={placeholder}
            autoFocus
            onKeyDown={e => { if (e.key === "Enter" && canConfirm) { e.preventDefault(); onConfirm(reason.trim()); onOpenChange(false); } }}
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canConfirm}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
