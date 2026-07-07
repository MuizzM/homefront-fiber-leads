import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { UserPlus, Trash2, Power, Mail, Shield } from "lucide-react";

interface AppUser {
  id: number;
  name: string;
  email: string;
  role: "admin" | "rep";
  active: boolean;
  teamMemberId: number | null;
}

interface TeamMember {
  id: number;
  name: string;
  email: string;
  role: string;
}

export default function Users() {
  const { user: me } = useAuth();
  const canDeleteUsers = ["admin", "manager"].includes(me?.role ?? "");
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [newTeamMemberId, setNewTeamMemberId] = useState<string>("");

  const { data: users = [], isLoading } = useQuery<AppUser[]>({
    queryKey: ["/api/users"],
  });

  const { data: teamMembers = [] } = useQuery<TeamMember[]>({
    queryKey: ["/api/team"],
  });

  const createMutation = useMutation({
    mutationFn: async (data: { name: string; email: string; teamMemberId?: number }) => {
      const res = await apiRequest("POST", "/api/users", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setShowCreate(false);
      setNewName(""); setNewEmail(""); setNewTeamMemberId("");
      toast({ title: "Rep account created. They can now log in with email code." });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, active }: { id: number; active: boolean }) => {
      const res = await apiRequest("PATCH", `/api/users/${id}`, { active });
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/users"] }),
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/users/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "User removed" });
    },
    onError: (err: any) => toast({ title: err.message, variant: "destructive" }),
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    createMutation.mutate({
      name: newName,
      email: newEmail,
      teamMemberId: newTeamMemberId ? Number(newTeamMemberId) : undefined,
    });
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-foreground">User Accounts</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage who can log into the app</p>
        </div>
        <button
          onClick={() => setShowCreate(!showCreate)}
          data-testid="button-add-user"
          className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors"
        >
          <UserPlus size={15} />
          Add Rep
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <form onSubmit={handleCreate} className="bg-card border border-border rounded-xl p-4 mb-6 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">New Rep Account</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Name</label>
              <input
                value={newName} onChange={e => setNewName(e.target.value)}
                placeholder="Rep name" required
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-orange-500"
                data-testid="input-new-user-name"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Email</label>
              <input
                type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)}
                placeholder="rep@email.com" required
                className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-orange-500"
                data-testid="input-new-user-email"
              />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Link to team member (optional)</label>
            <select
              value={newTeamMemberId}
              onChange={e => setNewTeamMemberId(e.target.value)}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-orange-500"
              data-testid="select-team-member"
            >
              <option value="">— No link —</option>
              {teamMembers.map(m => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button type="submit" disabled={createMutation.isPending}
              className="bg-orange-500 hover:bg-orange-600 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors disabled:opacity-50"
              data-testid="button-create-user">
              {createMutation.isPending ? "Creating…" : "Create account"}
            </button>
            <button type="button" onClick={() => setShowCreate(false)}
              className="border border-border text-sm px-4 py-2 rounded-lg hover:bg-accent transition-colors text-foreground">
              Cancel
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Rep will log in with a one-time code sent to their email.
          </p>
        </form>
      )}

      {/* User list */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground py-8 text-center">Loading…</div>
      ) : users.length === 0 ? (
        <div className="text-sm text-muted-foreground py-8 text-center">No users yet.</div>
      ) : (
        <div className="space-y-2">
          {users.map(u => (
            <div
              key={u.id}
              data-testid={`row-user-${u.id}`}
              className={`flex items-center justify-between bg-card border rounded-xl px-4 py-3 ${u.active ? "border-border" : "border-border opacity-50"}`}
            >
              <div className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white ${u.role === "admin" ? "bg-orange-500" : "bg-blue-500"}`}>
                  {u.name.slice(0, 2).toUpperCase()}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{u.name}</span>
                    {u.role === "admin" && (
                      <span className="flex items-center gap-1 text-xs bg-orange-500/20 text-orange-400 px-1.5 py-0.5 rounded">
                        <Shield size={10} /> Admin
                      </span>
                    )}
                    {!u.active && <span className="text-xs text-red-400">Disabled</span>}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                    <Mail size={10} />{u.email}
                  </div>
                </div>
              </div>

              {/* Actions — can't modify yourself */}
              {u.id !== me?.id && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => toggleMutation.mutate({ id: u.id, active: !u.active })}
                    data-testid={`button-toggle-user-${u.id}`}
                    title={u.active ? "Disable account" : "Enable account"}
                    className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
                  >
                    <Power size={14} />
                  </button>
                  {canDeleteUsers && (
                    <button
                      onClick={() => {
                        if (confirm(`Remove ${u.name}?`)) deleteMutation.mutate(u.id);
                      }}
                      data-testid={`button-delete-user-${u.id}`}
                      title="Remove login"
                      className="p-1.5 rounded-lg hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* SMTP note */}
      <div className="mt-8 bg-card border border-border rounded-xl p-4 text-xs text-muted-foreground space-y-1">
        <p className="font-medium text-foreground text-sm">Email delivery</p>
        <p>To send real OTP emails, set these env vars on your server:</p>
        <code className="block bg-background rounded p-2 text-xs mt-1 text-orange-400">
          SMTP_HOST=smtp.gmail.com<br/>
          SMTP_PORT=587<br/>
          SMTP_USER=your@gmail.com<br/>
          SMTP_PASS=your-app-password
        </code>
        <p className="mt-2">Without SMTP, codes print to the server console — useful for testing.</p>
      </div>
    </div>
  );
}
